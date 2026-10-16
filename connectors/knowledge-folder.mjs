#!/usr/bin/env node
// A knowledge-source connector for the Talkif session bridge: answers `lookup`
// (and `ask`) from a folder of Markdown / text files, over the bridge WebSocket.
// Proves the bus is not Claude-only: plain search, no model, nothing exposed.
//
//   node connectors/knowledge-folder.mjs <folder> [--name docs] [--topics docs,pricing]
//                                                  [--audience private|team|public]
//                                                  [--url URL] [--key-env VAR] [--env-file PATH]
//
// The backend and key resolve as in connectors/setup.mjs: https://api.talkif.ai by default,
// the key from $TALKIF_API_KEY (or --key-env VAR), ~/.config/talkif/dev.env
// as the developer fallback.
//
// --audience: private (only you), team (your organization, the default) or public
// (any caller of your account's flows whose Connectors node is open to callers;
// such a connector only answers `lookup`). Only put public material in a public folder.
//
// Needs Node 22+ (built-in WebSocket). The key needs the Connectors scope (session_bridge).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { USER_AGENT } from "./user-agent.mjs";
import { SETUP_FLAGS, resolveConnection } from "./setup.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const folder = args.find(a => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--"));
if (!folder) {
  console.error(`usage: knowledge-folder.mjs <folder> [--name docs] [--topics a,b] [--audience private|team|public] ${SETUP_FLAGS}`);
  process.exit(2);
}
const name = opt("name", basename(folder)).slice(0, 80);
const topics = opt("topics", name).toLowerCase();
const audience = opt("audience", "team");
if (!["private", "team", "public"].includes(audience)) {
  console.error(`--audience must be private, team or public (got ${audience})`);
  process.exit(2);
}
// A public connector is reached by any caller: lookups only, never a question it would reason over.
const handles = audience === "public" ? ["lookup"] : ["lookup", "ask"];
const { url: api, urlFrom, key, keyFrom } = resolveConnection(args);

// --- index: paragraphs of every .md / .mdx / .txt file -------------------------
const STOP = new Set("the and for are but not you all any can had her was one our out has have this that with from they will what when your about which there their would could should into than then them these those does how who why where is it in of on to a an or be by as at we do if so no".split(" "));
const words = text => (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(w => !STOP.has(w));

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const path = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, out);
    else if (/\.(md|mdx|txt)$/i.test(entry) && st.size < 2_000_000) out.push(path);
  }
  return out;
}

const paragraphs = [];
for (const file of walk(folder)) {
  const rel = relative(folder, file);
  for (const block of readFileSync(file, "utf8").split(/\n\s*\n/)) {
    const text = block.replace(/\s+/g, " ").trim();
    if (text.length >= 40) paragraphs.push({ file: rel, text, terms: new Set(words(text)) });
  }
}
console.log(`${name}: indexed ${paragraphs.length} paragraphs from ${folder} (audience ${audience}; backend ${api} from ${urlFrom}, key from ${keyFrom})`);

function search(query) {
  const q = [...new Set(words(query))];
  return paragraphs
    .map(p => ({ p, score: q.filter(t => p.terms.has(t)).length }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
}

function answer(query) {
  const hits = search(query);
  if (hits.length === 0) return `Nothing about that in ${name}.`;
  return hits.map(({ p }) => `From ${p.file}: ${p.text.slice(0, 450)}`).join("\n").slice(0, 1200);
}

// --- bridge WebSocket ------------------------------------------------------------
const url =
  `${api.replace(/^http/, "ws")}/api/v1/session-bridge/ws` +
  `?label=${encodeURIComponent(name)}&kind=knowledge_source&handles=${handles.join(",")}&topics=${encodeURIComponent(topics)}` +
  // `private` stays for backends older than the audience field (they treat public as team).
  `&audience=${audience}&private=${audience === "private"}` +
  `&description=${encodeURIComponent(`Knowledge source: ${paragraphs.length} paragraphs from ${basename(folder)}`)}`;
let backoff = 1000;

function connect() {
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}`, "User-Agent": USER_AGENT } });
  const send = frame => ws.send(JSON.stringify({ v: 1, ...frame }));
  ws.onopen = () => { backoff = 1000; };
  ws.onclose = e => {
    console.log(`${name}: socket closed (${e.code}${e.reason ? ` ${e.reason}` : ""}); reconnecting in ${backoff / 1000}s`);
    setTimeout(connect, backoff);
    backoff = Math.min(60_000, backoff * 2);
  };
  ws.onerror = () => {};
  ws.onmessage = m => {
    const frame = JSON.parse(m.data);
    const question = frame.data?.question ?? "";
    switch (frame.type) {
      case "session.registered":
        console.log(`${name}: registered as ${frame.data.sessionId}`);
        break;
      case "session.offer":
        // Claim only what this folder can actually answer.
        if (handles.includes(frame.data?.intent) && search(question).length > 0) send({ type: "session.claim", id: frame.id });
        break;
      case "session.ask":
        if (!handles.includes("ask")) {
          send({ type: "session.answer", id: frame.id, data: { text: `${name} only answers lookups.`, endCall: false } });
          break;
        }
      // falls through
      case "session.lookup":
        send({ type: "session.ack", id: frame.id });
        send({ type: "session.answer", id: frame.id, data: { text: answer(question), endCall: false } });
        break;
      case "session.error":
        console.log(`${name}: ${frame.data?.code}: ${frame.data?.message}`);
        break;
      default:
        break;
    }
  };
}
connect();
