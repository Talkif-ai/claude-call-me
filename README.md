# call-me: talk to Claude Code through the Talkif app

call-me connects your Claude Code sessions to your Talkif voice agent. You call the agent from the Talkif app and ask your sessions questions or give them tasks by voice. A session can also call you when it needs a decision from you.

## Before you start

You need:

- **A Talkif account.** You sign in to the Talkif app (iPhone, web dashboard or desktop) with it.
- **Connectors turned on.** An owner or admin of the account turns them on in the Talkif dashboard: **Developer → Integrations**.
- **A voice agent with a Connectors node.** In the Talkif flow builder, add a **Connectors** node to an agent and publish the flow. The plugin uses the first published flow that has one. To use another flow, set the `flowId` option.

## Setup in 3 steps

**1. Create an API key.** In the Talkif dashboard go to **Developer → Credentials** and create a key with these three scopes:

| Scope | Why |
|---|---|
| **Connectors** (`session_bridge:write`) | your sessions join your voice agent, answer it and ring you |
| **Calls** (`calls:read`) | the session gets the transcript after a call |
| **Flows** (`flows:read`) | the plugin finds the flow your calls run on |

Create the key yourself, signed in as you: what the key registers belongs to the person who created it.

**2. Install the plugin.** At the Claude Code prompt:

```
/plugin install call-me --marketplace Talkif-ai/claude-call-me
```

Answer `y` to add the marketplace and choose the **user** scope. The repository is private: you need read access to it on GitHub and a git login for github.com on your machine (an SSH key, or `gh auth login` then `gh auth setup-git`).

**3. Paste the key and check.** The install asks for the plugin's options. Paste the key into **Talkif API key** and leave **API URL (advanced)** empty. To change the key later: `/plugin` → Installed → call-me → **Configure options**. The key is kept in your system keychain, not in a settings file.

Then run:

```
/cm setup
```

When everything is ready you see:

```
call-me setup
[ok]      API key: from the apiKey option (keychain)
[ok]      Backend: https://api.talkif.ai (Talkif, the default)
[ok]      Connectors: turned on for this account (by Ada Lovelace)
[ok]      Call history: the key can read calls and transcripts
[ok]      Flow: "Claude Code calls" (<flow id>, the first published flow with a Connectors node; set flowId in /config → call-me to choose another)

All set. Call your Talkif agent from the Talkif app (signed in), or let a session ring you with call_me.
```

If something is missing, it says what to do next, for example:

```
[missing] Connectors: not turned on for this account

Next step: An owner or admin of the Talkif account turns Connectors on in the dashboard: Developer → Integrations.
Run /cm setup again after each step.
```

`/cm setup` only reads. It never prints your key.

## Using it

**You call in.** Open the Talkif app, signed in, and call your voice agent. It knows which Claude Code sessions are connected and what each one is working on. Say what you want:

- "Ask the web app session why the build failed."
- "What did the API session change today?"
- "Tell the mobile app session to look into the login crash."
- "Call me back when it's done."

**Ask or task.** A question is an **ask**: the session answers right away and the agent reads you the answer. Something to do is a **task**: the agent tells you in one sentence what it sends and to which session, and sends it. When the task finishes, you hear the result on the call. If you have hung up by then, the session rings you with the result. Say "just tell me next time" and it waits for your next call instead.

**The session calls you.** When a session needs a decision from you, it uses the `call_me` tool. Your Talkif app rings. The agent asks the session's questions one by one, and the answers go back to the session when the call ends.

**What you say reaches every session.** After each call, a short summary goes to all your connected sessions, so what you explained on one call is known everywhere.

## Safety

- **Tasks from a call are read-only by default.** While such a task runs, only tools that read work: reading files, searching, `git status`, `git log`, `git diff` and a few other read-only commands. Anything that changes something is refused, and the session tells you what it would change. You approve that at the terminal. To let call tasks use the session's normal Claude Code permissions, set the option `callTasks` to `session`. The plugin never grants a permission by itself.
- **Credential files are not read during a call task**: for example `~/.ssh`, `~/.aws`, `.env` files and key files.
- **Secrets are kept off the call, as well as possible.** The voice agent and the sessions are told never to say keys, tokens or passwords. The plugin also replaces text that looks like a secret with `[redacted]` before it leaves your machine. This is best effort: a secret in an unusual format can still get through.
- **Only you count as you.** Only a call you start from the Talkif app while signed in, or a call a session places to you, reaches your sessions. A call from a phone number (even yours), an embed or an API key does not.
- **Coding sessions are private.** Teammates in your organization cannot ask or task your sessions.
- **Call text is treated as data.** Transcripts and call summaries reach the session marked as text from a call, not as instructions.

## Commands

| Command | What it does |
|---|---|
| `/cm` | status: key, server, flow, folders, any problem, and whether this session is on |
| `/cm setup` | checks your setup and prints the next step for what is missing |
| `/cm on` · `/cm off` | this session joins or leaves your voice agent |
| `/cm on all` · `/cm off all` | every session on this machine |
| `/cm default on` · `/cm default off` | whether new sessions start on or off |
| `/cm traffic` | live pane of this session's call-me traffic (needs the `debug` option) |
| `/cm publish` | writes call-me's instructions into the flow's Connectors node (the key also needs `flows:write`) |
| `/cm latency` | times how fast this session answers |

## Options

Change them in `/config` → call-me. The API key is in `/plugin` → Installed → call-me → **Configure options**.

| Option | Default | What it does |
|---|---|---|
| `apiKey` | empty | your Talkif API key, kept in the keychain |
| `apiUrl` | empty | API URL (advanced). Empty: Talkif (https://api.talkif.ai). Only change it if Talkif support tells you to |
| `flowId` | empty | the flow your calls run on. Empty: the first published flow with a Connectors node |
| `folders` | empty | only sessions in these folders join, comma-separated (`~/work/app, ~/notes`). Empty: every session |
| `callTasks` | `read-only` | `read-only`: tasks from a call can only read. `session`: they use the session's own permissions |
| `callback` | on | ring you when a task from a call ends after you hung up |
| `parallel` | off | queue more tasks from a call while one runs, instead of saying "still on the last task" |
| `debug` | off | record this session's traffic for `/cm traffic` |

## Other connectors

Besides Claude Code sessions, two small scripts can join your voice agent. They run on your machine with Node 22 or newer and take the key from the environment (a key with the Connectors scope):

```
export TALKIF_API_KEY=…
```

**Knowledge folder**: answers questions from a folder of `.md`, `.mdx` and `.txt` files.

```
node connectors/knowledge-folder.mjs ~/notes/product-docs --name "product docs"
```

Your organization's members can ask it too. Add `--audience private` to keep it to you, or `--audience public` to let any caller of your flows look things up in it (only for material you would publish).

**Launcher**: answers questions about GitHub, CI, logs and deploys by running Claude Code in plan mode (read-only) with your own tools.

```
node connectors/launcher.mjs --cwd ~/work --name ops
```

It only answers questions, never takes tasks, and only you can reach it. Both scripts take `--topics a,b,c` (what they are about).

## Troubleshooting

| You see | Fix |
|---|---|
| `no Talkif API key set` | Create a key (step 1) and paste it in `/plugin` → Installed → call-me → Configure options. |
| `Connectors are not turned on for this account` | An owner or admin turns them on in the dashboard: Developer → Integrations. Then run `/cm setup`. |
| `the API key lacks a scope this needs` | Edit the key in Developer → Credentials and add the scope `/cm setup` names. |
| `this IP is not on the API key allowlist` | Add your current IP address to the key, or remove the restriction. call-me pauses and checks again every 5 minutes. |
| `no published flow with a Connectors node in this account` | Add a Connectors node to an agent in the flow builder and publish it, or set `flowId`. |
| `the API key was refused (expired or revoked?)` | Create a new key and paste it in Configure options. |
| `/cm` is an unknown command in a session | The session's folder is not in the `folders` option. Add it, or empty the option. |
| Your call does not reach the session | Call from the Talkif app while signed in, and check `/cm` says this session is on. |

After a plugin update, run `/reload-plugins` to use it without restarting.

## For Talkif developers

To point the plugin at another Talkif API, set **API URL (advanced)**. Or leave the `apiKey` option empty and put the URL and keys in `~/.config/talkif/dev.env` (mode 600); this also lets one machine join several accounts at once:

```
TALKIF_API_URL=https://…  # optional: empty means https://api.talkif.ai
TALKIF_API_KEY=…         # scopes: calls, flows
TALKIF_BRIDGE_KEY=…      # scope: Connectors (your personal account)
TALKIF_ORG_BRIDGE_KEY=…  # optional: Connectors in another account (any TALKIF_<NAME>_BRIDGE_KEY)
```

The **API URL (advanced)** option, when set, beats the file's `TALKIF_API_URL`; `flowId` and `folders` apply as usual. The connector scripts read the same file as a fallback (`--env-file PATH` picks another) and also take `--url URL` (or `TALKIF_API_URL`) and `--key-env VAR`. `node connectors/agent.mjs` is an experimental local helper that holds a WebSocket per session instead of long polling; it is not needed.

Checks before a release: `claude plugin validate . --strict`, `claude plugin test .` and `tsc -p . --noEmit`.
