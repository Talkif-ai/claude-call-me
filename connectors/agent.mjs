#!/usr/bin/env node
// The local call-me agent: holds the bridge WebSocket for every Claude Code
// session on this machine, so turns are pushed instead of long-polled over the
// internet. The plugin cannot open a WebSocket (its API has only fetch, which
// can go over a Unix socket), so it talks to this agent on
//   ~/.config/talkif/call-me/agent.sock
// with the very same REST paths it would send to the backend
// (/api/v1/session-bridge/...). No socket file, or the agent gone: the plugin
// falls back to long-polling the backend by itself.
//
//   node connectors/agent.mjs [--url URL] [--env-file PATH]
//
// Start it on the same backend as the plugin (its API URL option). The backend
// resolves as in connectors/setup.mjs: --url, $TALKIF_API_URL, the developer
// file ~/.config/talkif/dev.env, else https://api.talkif.ai.
//
// Needs Node 22+ (built-in WebSocket). Keys come from each request's
// Authorization header (the plugin's own bridge keys); the agent stores none.
import { createServer } from "node:http";
import { existsSync, mkdirSync, unlinkSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { USER_AGENT } from "./user-agent.mjs";
import { resolveConnection } from "./setup.mjs";

const args = process.argv.slice(2);
const home = homedir();
const { url: API, urlFrom } = resolveConnection(args, { needKey: false });
const SOCKET = join(home, ".config/talkif/call-me/agent.sock");
const PREFIX = "/api/v1/session-bridge";
const HOLD_MS = 20_000;
const REPLY_WAIT_MS = 8_000;

// sessionId → { ws, key, clientKey, turns: [], waiters: [], pending: Map, events: [] }
const sessions = new Map();

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function openSession(key, body) {
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams();
    for (const f of ["label", "description", "kind", "audience"]) if (typeof body[f] === "string" && body[f]) q.set(f, body[f]);
    if (Array.isArray(body.handles)) q.set("handles", body.handles.join(","));
    if (Array.isArray(body.topics) && body.topics.length) q.set("topics", body.topics.join(","));
    if (typeof body.private === "boolean") q.set("private", String(body.private));
    const ws = new WebSocket(`${API.replace(/^http/, "ws")}${PREFIX}/ws?${q}`, { headers: { Authorization: key, "User-Agent": USER_AGENT } });
    let session;
    const timer = setTimeout(() => { ws.close(); reject(new Error("register timed out")); }, 10_000);
    ws.onmessage = m => {
      const frame = JSON.parse(m.data);
      if (frame.type === "session.registered") {
        clearTimeout(timer);
        session = { id: frame.data.sessionId, ws, key, clientKey: body.clientKey, turns: [], waiters: [], pending: new Map(), events: [] };
        sessions.set(session.id, session);
        log(`registered ${session.id.slice(0, 8)} ${body.label ?? ""}`);
        resolve({ sessionId: session.id, pollTimeoutSecs: HOLD_MS / 1000, replyTimeoutSecs: frame.data.replyTimeoutSecs ?? 30 });
        return;
      }
      if (session) onFrame(session, frame);
    };
    ws.onclose = e => {
      clearTimeout(timer);
      if (!session) return reject(new Error(`socket closed before registering (${e.code} ${e.reason})`));
      // Gone: the plugin's next /next gets 404 and registers again.
      sessions.delete(session.id);
      for (const w of session.waiters) w(null);
      for (const [, p] of session.pending) p({ error: "socket closed" });
      log(`closed ${session.id.slice(0, 8)} (${e.code})`);
    };
    ws.onerror = () => {};
  });
}

function onFrame(session, frame) {
  switch (frame.type) {
    case "session.turn":
    case "session.ask":
    case "session.instruction":
    case "session.lookup":
    case "session.offer": {
      const data = frame.data ?? {};
      const kind = data.kind ?? (frame.type === "session.offer" ? "offer" : frame.type.slice("session.".length));
      const turn = { messages: [], callId: data.callId ?? "", ...data, kind, requestId: data.requestId ?? frame.id };
      const waiter = session.waiters.shift();
      if (waiter) waiter(turn);
      else session.turns.push(turn);
      break;
    }
    case "session.claimed":
    case "session.error": {
      const p = session.pending.get(frame.id);
      if (p) { session.pending.delete(frame.id); p(frame.type === "session.error" ? { error: frame.data } : frame.data); }
      break;
    }
    case "session.event.ack": {
      const p = session.events.shift();
      if (p) p(frame.data ?? { delivered: false });
      break;
    }
    default:
      break;
  }
}

const send = (session, frame) => session.ws.readyState === WebSocket.OPEN && session.ws.send(JSON.stringify({ v: 1, ...frame }));
const waitFor = (session, id) =>
  new Promise(resolve => {
    session.pending.set(id, resolve);
    setTimeout(() => { if (session.pending.delete(id)) resolve({ error: "timeout" }); }, REPLY_WAIT_MS);
  });

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};

// Anything the agent does not handle (e.g. POST /calls to ring) goes to the backend as is.
async function proxy(req, res, raw) {
  const r = await fetch(`${API}${req.url}`, {
    method: req.method,
    headers: { Authorization: req.headers.authorization ?? "", "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: ["GET", "HEAD"].includes(req.method) ? undefined : raw,
  });
  res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") ?? "application/json" });
  res.end(await r.text());
}

async function handle(req, res) {
  const url = new URL(req.url, "http://agent");
  const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : null;
  const key = req.headers.authorization ?? "";
  if (path === null) return json(res, 404, { error: "not a bridge path" });
  const raw = req.method === "GET" ? "" : await (async () => { let s = ""; for await (const c of req) s += c; return s; })();
  const body = raw ? JSON.parse(raw) : {};
  const m = /^\/([0-9a-f-]{36})(?:\/(next|reply|ack|claim|event))?$/.exec(path);

  // Register: one socket per session; the same client key reuses the live one.
  if (path === "" && req.method === "POST") {
    for (const s of sessions.values()) {
      if (body.clientKey && s.clientKey === body.clientKey && s.key === key) return json(res, 200, { sessionId: s.id, pollTimeoutSecs: HOLD_MS / 1000, replyTimeoutSecs: 30 });
    }
    try {
      return json(res, 201, await openSession(key, body));
    } catch (e) {
      return json(res, 502, { error: String(e.message ?? e) });
    }
  }
  if (!m) return proxy(req, res, raw);
  const session = sessions.get(m[1]);
  if (!session || session.key !== key) return json(res, 404, { error: "unknown session" });
  const op = m[2];

  if (!op && req.method === "DELETE") { session.ws.close(1000, "left"); return json(res, 204); }
  if (!op && req.method === "PUT") { send(session, { type: "session.describe", data: body }); return json(res, 204); }
  if (op === "next" && req.method === "GET") {
    const ready = session.turns.shift();
    if (ready) return json(res, 200, ready);
    const turn = await new Promise(resolve => {
      const waiter = t => { clearTimeout(timer); resolve(t); };
      const timer = setTimeout(() => { session.waiters = session.waiters.filter(w => w !== waiter); resolve(undefined); }, HOLD_MS);
      session.waiters.push(waiter);
    });
    if (turn === null) return json(res, 404, { error: "session closed" });
    return turn ? json(res, 200, turn) : json(res, 204);
  }
  if (op === "reply") { send(session, { type: "session.answer", id: body.requestId, data: { text: body.text ?? "", endCall: body.endCall === true } }); return json(res, 204); }
  if (op === "ack") { send(session, { type: "session.ack", id: body.requestId }); return json(res, 204); }
  if (op === "claim") {
    send(session, { type: "session.claim", id: body.requestId, score: typeof body.score === "number" ? body.score : undefined });
    const r = await waitFor(session, body.requestId);
    return r.error ? json(res, 200, { won: false }) : json(res, 200, { won: r.won === true });
  }
  if (op === "event") {
    const done = new Promise(resolve => {
      session.events.push(resolve);
      setTimeout(() => { const i = session.events.indexOf(resolve); if (i >= 0) { session.events.splice(i, 1); resolve({ delivered: false }); } }, REPLY_WAIT_MS);
    });
    send(session, { type: "session.event", data: { kind: body.kind, text: body.text } });
    return json(res, 200, await done);
  }
  return proxy(req, res, raw);
}

// --- start ------------------------------------------------------------------------
mkdirSync(dirname(SOCKET), { recursive: true, mode: 0o700 });
chmodSync(dirname(SOCKET), 0o700); // an older agent made it 0755
if (existsSync(SOCKET)) unlinkSync(SOCKET); // a socket left by an agent that died
const server = createServer((req, res) => {
  handle(req, res).catch(e => { log(`error ${req.method} ${req.url}: ${e.message}`); if (!res.headersSent) json(res, 500, { error: String(e.message) }); });
});
server.listen(SOCKET, () => {
  chmodSync(SOCKET, 0o600); // this user only
  log(`call-me agent on ${SOCKET} → ${API} (from ${urlFrom}; WebSocket per session)`);
});
const shutdown = () => {
  for (const s of sessions.values()) s.ws.close(1001, "agent stopping");
  server.close();
  if (existsSync(SOCKET)) unlinkSync(SOCKET);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
