#!/usr/bin/env node
// A launcher connector for the Talkif session bridge: answers the developer's
// questions (`ask`, `lookup`) by starting a headless Claude Code run in a folder
// with their own tools, MCP connectors and permission rules (GitHub, CI, logs,
// BetterStack, ArgoCD, Kubernetes, Talkif). Read-only: every run is in plan mode,
// tasks (`tell`) are not taken, nothing is changed by voice. Always private: the
// runs use the developer's own credentials, so only they reach it, never a teammate.
//
//   node connectors/launcher.mjs [--cwd DIR (default: the current folder)] [--name ops]
//        [--topics github,ci,logs,betterstack,argocd,kubernetes,deploys,production]
//        [--timeout 180] [--url URL] [--key-env VAR] [--env-file PATH]
//
// The backend and key resolve as in connectors/setup.mjs: https://api.talkif.ai by default,
// the key from $TALKIF_API_KEY (or --key-env VAR), ~/.config/talkif/dev.env
// as the developer fallback.
//
// Needs Node 22+ (built-in WebSocket) and `claude` on PATH. The key needs the
// Connectors scope (session_bridge). One run at a time; a slow answer reaches the call as a note.
import { homedir } from "node:os";
import { USER_AGENT } from "./user-agent.mjs";
import { resolveConnection } from "./setup.mjs";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const home = homedir();
const cwd = opt("cwd", process.cwd()).replace(/^~(?=\/|$)/, home);
const name = opt("name", "ops").slice(0, 80);
const topics = opt("topics", "github,ci,logs,betterstack,argocd,kubernetes,deploys,production").toLowerCase();
const timeoutSecs = Number(opt("timeout", "180"));
const { url: api, urlFrom, key, keyFrom } = resolveConnection(args);

// Words that make a question this connector's: it claims those offers.
const MINE = /\b(ci|github|pr|pull request|build|check|workflow|log|logs|error|errors|betterstack|incident|argo|argocd|deploy|deployed|rollout|kubectl|pod|pods|cluster|prod|production|release|version|sentry|alert)\b/i;

const PROMPT = question =>
  [
    "A question from the developer's phone call, through their Talkif voice assistant. It is speech-to-text: names may be misheard.",
    "Find the answer with read-only tools only (gh, kubectl get/describe/logs, the BetterStack and other connectors, git, files). Never change anything: no deploys, writes, restarts, merges or comments.",
    "Answer in two to four plain spoken sentences, in the language of the question, with the facts that matter (names, numbers, times in UTC). No lists, no code, no file paths. If you cannot find out, say what you checked.",
    "Never include secrets: no API keys, tokens, passwords, private keys or the contents of env or credential files. Summarize instead.",
    "",
    `Question: ${question}`,
  ].join("\n");

// The runs never see the connector's own key (a run could print its environment).
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== key));

// One Claude run; resolves to its final text.
function run(question) {
  return new Promise(resolve => {
    const child = spawn("claude", ["-p", PROMPT(question), "--permission-mode", "plan", "--output-format", "text"], {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", d => (out += d));
    child.stderr.on("data", d => (err += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutSecs * 1000);
    child.on("close", code => {
      clearTimeout(timer);
      const text = out.trim();
      if (text) resolve(text.slice(0, 1500));
      else resolve(`I could not find that out (${code === null ? "timed out" : `exit ${code}`}${err.trim() ? `: ${err.trim().slice(0, 200)}` : ""}).`);
    });
    child.on("error", e => {
      clearTimeout(timer);
      resolve(`I could not start Claude Code: ${e.message}.`);
    });
  });
}

// One run at a time: questions wait their turn.
let queue = Promise.resolve();
const enqueue = job => (queue = queue.then(job, job));

// --- bridge WebSocket ------------------------------------------------------------
const url =
  `${api.replace(/^http/, "ws")}/api/v1/session-bridge/ws` +
  `?label=${encodeURIComponent(name)}&kind=agent&handles=ask,lookup&topics=${encodeURIComponent(topics)}` +
  // `private` stays for backends older than the audience field.
  "&audience=private&private=true" +
  `&description=${encodeURIComponent(`Answers questions about ${topics.split(",").join(", ")} by running Claude Code read-only in ${cwd}`)}`;
let backoff = 1000;

function connect() {
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}`, "User-Agent": USER_AGENT } });
  const send = frame => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ v: 1, ...frame }));
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
        console.log(`${name}: registered as ${frame.data.sessionId} (cwd ${cwd}; backend ${api} from ${urlFrom}, key from ${keyFrom})`);
        break;
      case "session.offer":
        if (["ask", "lookup"].includes(frame.data?.intent) && MINE.test(question)) send({ type: "session.claim", id: frame.id });
        break;
      case "session.lookup":
      case "session.ask":
        // Acknowledge at once: the call hears that it is being looked into.
        send({ type: "session.ack", id: frame.id });
        console.log(`${name}: question ${frame.id}: ${question.slice(0, 120)}`);
        enqueue(async () => {
          const text = await run(question);
          send({ type: "session.answer", id: frame.id, data: { text, endCall: false } });
          console.log(`${name}: answered ${frame.id} (${text.length} chars)`);
        });
        break;
      case "session.instruction":
        // Read-only connector: tasks belong to a coding session.
        send({ type: "session.answer", id: frame.id, data: { text: `${name} only answers questions; give tasks to a coding session.`, endCall: false } });
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
