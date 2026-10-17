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

Answer `y` to add the marketplace and choose the **user** scope.

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
[ok]      Connectors: turned on for the account Acme (by Ada Lovelace)
[ok]      Call history: the key can read calls and transcripts
[ok]      Flow: "Claude Code calls" (<flow id>, the first published flow with a Connectors node; set flowId in /config → call-me to choose another)

All set. Call your Talkif agent from the Talkif app (signed in), or let a session ring you with call_me.

Details
Accounts: Acme (connected)
Folders: every session (set folders in /config → call-me to limit)
This session: follows the default
All sessions: on. New sessions start on.

☎ On. This session can be reached through Acme.
Call "Claude Code calls" in the Talkif app.
More: /cm help
```

If something is missing, it says what to do next, for example:

```
[missing] Connectors: not turned on for this account

Next step: An owner or admin of the Talkif account turns Connectors on in the dashboard: Developer → Integrations.
Run /cm setup again after each step.
```

`/cm setup` only reads. It never prints your key.

## Is it on?

Under the prompt, call-me shows one status line:

| Status line | What it means |
|---|---|
| `☎ call-me: on · Acme` | this session can be reached through your voice agent, in the account named after the dot |
| `☎ call-me: on a call` | a call is ringing or running for this session, or a task from a call is running or queued |
| `☎ call-me: connecting…` | the connection to Talkif is coming up, or dropped and retries by itself |
| `☎ call-me: off` | this session is switched off (`/cm on` turns it back on) |
| `☎ call-me: not set up — run /cm setup` | no API key, a setup problem, or Talkif refused the key: `/cm` says why, `/cm setup` checks everything |

`/cm` gives the same answer in two or three lines, for example:

```
☎ On. This session can be reached through Acme.
Call "Claude Code calls" in the Talkif app.
More: /cm help
```

```
☎ Not set up: Connectors are not turned on for your Talkif account.
Next: An owner or admin turns them on in the Talkif dashboard (Developer → Integrations).
More: /cm help
```

When Talkif refuses the key (Connectors off, a missing scope, an IP allowlist), call-me tries again every 30 seconds and comes back on by itself once it is fixed. `/cm setup` tries again at once.

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
- **Only proven callers count.** A call reaches sessions only when it is started from the Talkif app or dashboard while signed in, when a session places it to you, or when you confirm on your signed-in Talkif app that a call from your phone number is you. Any other call from a phone number, an embed or an API key does not.
- **Call text is treated as data.** Transcripts and call summaries reach the session marked as text from a call, not as instructions.

## Who can reach what

- **Personal account:** only you reach your sessions and connectors.
- **Organization:** every owner, admin and member of the organization on a proven call reaches all of its connectors, your coding sessions included: they can ask questions and give tasks. Each question or task names who asked by their Talkif profile name ("Question from Ada on a call", "Task from Ada on a call"), and the session's traffic shows it too. A task from someone else never rings you back. Sessions running a call-me older than 0.24.0 stay reachable by you alone.
- **Tasks from a call stay read-only by default**, whoever gives them (see `callTasks`).
- **Callers who are not proven** (phone numbers, embeds, API keys) reach nothing, except connectors you made public, and those only for look-ups.
## Commands

`/cm help` shows this list.

| Command | What it does |
|---|---|
| `/cm` | is this session reachable? |
| `/cm on` · `/cm off` | make this session reachable / not reachable |
| `/cm on all` · `/cm off all` | all open sessions on / off |
| `/cm default on` · `/cm default off` | how new sessions start |
| `/cm setup` | check the connection and show what's missing (also shows the key, flow, accounts and folders in use) |
| `/cm traffic` | see what went back and forth (needs the `debug` option) |

Advanced:

| Command | What it does |
|---|---|
| `/cm publish` | write the call prompt into your flow's Connectors node (the key also needs `flows:write`) |
| `/cm latency` | time a spoken answer |

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

Your organization's members can ask it too. Add `--audience public` to let any caller of your flows look things up in it (only for material you would publish).

**Launcher**: answers questions about GitHub, CI, logs and deploys by running Claude Code in plan mode (read-only) with your own tools.

```
node connectors/launcher.mjs --cwd ~/work --name ops
```

It only answers questions, never takes tasks, and only you can reach it (it runs with your own credentials). Both scripts take `--topics a,b,c` (what they are about).

## Troubleshooting

| You see | Fix |
|---|---|
| `no Talkif API key is set` | Create a key (step 1) and paste it in `/plugin` → Installed → call-me → Configure options. |
| `Connectors are not turned on for your Talkif account` | An owner or admin turns them on in the dashboard: Developer → Integrations. call-me notices within 30 seconds, or at once with `/cm setup`. |
| `the API key lacks a scope it needs` | Edit the key in Developer → Credentials and add the scope `/cm setup` names. |
| `this computer's IP address is not on the API key's allowlist` | Add your current IP address to the key, or remove the restriction. call-me checks again every 30 seconds. |
| `your Talkif account has no published flow with a Connectors node` | Add a Connectors node to an agent in the flow builder and publish it, or set `flowId`. |
| `the API key was refused (expired or revoked?)` | Create a new key and paste it in Configure options. |
| `/cm` is an unknown command in a session | The session's folder is not in the `folders` option. Add it, or empty the option. |
| Your call does not reach the session | Call from the Talkif app while signed in, and check `/cm` says `☎ On`. |

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

## License

MIT. See [LICENSE](LICENSE).
