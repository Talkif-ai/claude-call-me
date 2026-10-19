# Changelog

## 0.27.1 — 2026-10-19

- **One window, one session.** A window that also runs the talkif MCP server no longer registers a second session with the local daemon: the plugin finds the session that server registered (by this window's process, `talkif-agents` 0.4.3 or newer) and reads its items from there. Before, other agents saw two sessions for one window, and an item given to the MCP one waited for `check_inbox` and was then answered by the daemon's separate headless run, without the window's context. A window without the MCP server still registers its own session (after waiting up to 20 seconds for one to appear, and moving to it if it appears later). The plugin never claims a daemon job window's session id any more; that is the MCP server's.
- **Board jobs are no longer closed as done without being done.** The daemon now marks a board job, and a write job in its own worktree, in what it sends. A write job runs with writes only when `peerTasks` is `follow-hub`; with the default read-only setting the plugin leaves write jobs to `check_inbox` and refuses one that still reaches it (failed, with the reason), instead of running it read-only and reporting it completed. A board job's answer goes back as its job result, and its prompt no longer contradicts the daemon's own note.
- The shared test vectors are mirrored again (`local.json` is new; the refusal and hub-kind lists match the shared ones: the board kinds are hints only on the direct path).

## 0.27.0 — 2026-10-19

- **Agent Bridge through the local daemon.** When the `talkif-agents` daemon runs on this computer, each session registers with it (its folder; the daemon adds repository, branch and label) instead of connecting to Talkif itself, and the daemon's items for this session are pushed into the open window (long-polled on a daemon without push). A read task is now answered in the window that holds the context, instead of by the daemon's separate headless run after 8 seconds. Messages, results and any other item the daemon gives this session reach the window too, as fenced context and a toast.
- Tasks from the daemon run as marked turns, fenced as untrusted data, under the same read-only guard as other peer tasks; the turn's answer goes back to the daemon (`reply`) by itself. A task writes only when the daemon marks it as a write **and** `peerTasks` is `follow-hub`; then local edits run, an action the permission table cannot classify is approved once at the terminal, and every action that needs your passkey (push, merge, deploy, messages, secrets, payments) is refused.
- New option `localAgent` (default `claude`, overridden by `TALKIF_AGENT`): the local agent a session registers as. The connection runs in a small `node` child of the session; peer text and answers go over stdin and the socket, never a command line.
- Without the daemon nothing changes: the Connectors path and the direct Agent Bridge path work as before.

## 0.26.0 — 2026-10-17

- **`/cm connect`: connect this session to Agent Bridge with one command.** It shows a one-time code and opens the Talkif dashboard; you check the code and press Approve, and the agent is created and its credential comes straight to this session (never through the browser). The credential is kept in the `agentKey` option (your keychain), or, when that option holds another agent or cannot be set, in a file only you can read under `~/.config/talkif/agents/`. Pasting a credential by hand still works. The Connectors setup is unchanged.
- **Talkif Agent Bridge (early access):** with an Agent Bridge credential (`tif_agent_…`, new option `agentKey`), this session becomes one of your connected agents. It can reach your other coding sessions and your phone agent through Talkif with the new tools `list_agents`, `ask_agent`, `tell_agent`, `delegate`, `task_status` and `check_inbox`, and takes tasks from them. Without the credential nothing changes: no new tool, request or prompt text.
- Messages between agents are encrypted on this machine for each recipient and signed; Talkif relays them and cannot read them. Keys are made here and kept in the keychain (elsewhere a file only you can read). Secret-looking text is redacted before it is encrypted.
- Tasks from your other agents are **read-only by default** (new option `peerTasks`). Outward or irreversible actions always wait for your approval of that exact action; outward ones only with your passkey, which this machine verifies itself. New option `voiceApprovals` (default `deny`). New command `/talkif agent` (status, `bind`, `trust-owner`, `trust <agent id>`). See "Agent Bridge" in the README.
- In *auto*, the project's own programs (builds, tests, installs) run as local work under Claude Code's own permission mode or sandbox; the hold covers commands that act outward directly. Also held: deleting or moving after a `cd` out of the folder (the shell's folder is followed across calls), changing git config or remotes, `git rebase -x`, `git submodule foreach`, environment settings that pick another program (`GIT_SSH_COMMAND=…`, `PATH=…`), `--compress-program`-style options, and changes to files that run later (`.git/hooks`, `.git/config`, `.claude/`, `.mcp.json`, `.envrc`, `.vscode/`, `.husky/`).
- Tasks from other agents never search the home folder, `~/.config` or `/` recursively (`grep -r`, `rg`, the Grep tool), and a connected agent's private key is redacted if it ever shows up in text.
- An approval whose command, input or folder holds hidden characters (direction overrides, zero-width or control characters) shows them as `\uXXXX` and can only be denied.
- Ids from Talkif must be lower-case UUIDs before they name a file or a keychain entry (an envelope with any other spelling, recipients included, is dropped; the message id goes into the key derivation unchanged); recipients are chosen by exact id or name (or one unique prefix), never by a guess; a task without a target needs valid capabilities.
- A second session in the bound folder stands by before it opens anything, instead of taking the agent from the live session.
- Tasks Talkif ends without a result (failed, rejected, expired) leave the status line; old or misaddressed task bodies are dropped; a write task is not bid on when this machine would run it read-only.
- The agent binds to one folder: sessions in other folders do not act as it.
- Credential files now include `~/.claude` and `~/.claude.json` (Claude Code's own settings), also for tasks from a call. `tif_agent_` credentials are redacted like other keys.
- **One permission table everywhere:** a task's actions are now ranked by the shared Talkif Agent Protocol table (`test-vectors/tiers.json` v2), the same bytes and the same steps the hub and the other clients use, and which approval may answer them (here, by voice, or only with your passkey) comes from that table too. Changes from 0.26.0's own rules: the Agent tool and unknown tools are always asked; a background Bash command is ranked like the same command in the foreground; while the shell may be in a folder not known (after an approved `cd` out of the project), every command is asked until one starts with `cd <project path> &&`.
- Secret-looking text in messages to other agents and in approvals is redacted by the shared `secrets.json` patterns (also URL passwords, Stripe, Google and npm keys, JSON and YAML key fields), and this agent's own credential and private keys are removed by exact value. The Connectors bridge keeps its redaction unchanged.
- **Fix:** the asker's name (`callerName`) now reaches the question and task prompts; 0.24.0 read it but dropped it on the way.
- **License:** Apache License 2.0 from this release, with a NOTICE file (Talkif Agent Protocol, by Talkif). Releases up to 0.25.2 stay under the MIT License.

## 0.25.2 — 2026-10-17

- `/cm help` fits narrow terminals: when the two columns don't fit, each description goes on its own line under the command. Shorter descriptions.

## 0.25.1 — 2026-10-17

- `/cm help` lists the commands in two aligned columns.

## 0.25.0 — 2026-10-17

- **Fix: call-me no longer stays "not set up" after the problem is fixed.** When Talkif refused the key (for example Connectors not turned on yet), call-me waited 5 minutes before trying again, and `/cm setup` could report everything ok while `/cm` still said "Connectors are not turned on". Now it tries again every 30 seconds and comes back on by itself; `/cm setup` tries again at once and ends with the same live line `/cm` shows, so the two never disagree.
- **`/cm` is two or three lines:** on (through which account, and which agent to call), off (and how to turn it on), connecting, or not set up (the reason in plain words and exactly one next step). The details (key, server, flow, accounts, folders, switches) moved to `/cm setup`.
- **New `/cm help`:** one plain line per command, the common ones first. An unknown command answers "Unknown command. See /cm help." instead of the whole status.
- Accounts are shown only by their name in Talkif, never by key slot ("personal key"); without a name, "your Talkif account". The status line follows the same words and says `connecting…` instead of `reconnecting…`.
- `/cm off all` now says to turn it back on with `/cm on all` (`/cm on` alone did not, while every session was off). `/cm on` reconnects at once instead of within 20 seconds.
- `/cm traffic` without the debug option says how to turn it on instead of opening an empty pane.
- A flow set with the `flowId` option is shown by its name.

## 0.24.0 — 2026-10-17

- **Organizations share their connectors.** In an organization, every owner, admin and member on a proven call reaches all of its connectors, your coding sessions included, for questions and tasks. In a personal account only you do. See "Who can reach what" in the README.
- **Who asked:** a question or task from a call now starts with the asker's name ("Question from Ada on a call", "Task from Ada on a call") when Talkif sends it, and `/cm traffic` shows it. The name is cleaned to one short line before it reaches the prompt.
- Tasks from a call stay read-only by default, whoever gives them. A task from another member never rings you back.
- Registers with `callerNames`: in an organization, other members reach a session only when its call-me says who asked, so sessions on older versions stay yours alone.

## 0.23.0 — 2026-10-17

- **Is it on?** A status line under the prompt always says: `on · <account>`, `on a call`, `reconnecting…`, `off`, or `not set up — run /cm setup`. See "Is it on?" in the README.
- The account is shown by its name in Talkif (status line, `/cm`, `/cm setup`, traffic pane). Older servers that do not send the name show the key's slot name (`personal`) instead.
- `/cm` starts with one line: on and through which account, off, or not set up. The details follow.
- **Fix:** read-only mode for tasks from a call no longer reaches agents that were started outside that task (by you, or before the call). Only the task itself and the agents it starts are read-only.
- **Fix:** the User-Agent now carries the plugin's real version (it said 0.21.1 in 0.22.0).

## 0.22.0 — 2026-10-16

- **The `environment` option is gone.** call-me always connects to Talkif (https://api.talkif.ai). A new optional **API URL (advanced)** option (`apiUrl`) takes another address; leave it empty unless Talkif support tells you otherwise. An address that is not `http://` or `https://` is reported by `/cm setup` instead of being ignored.
- **Breaking for the connector scripts:** `--env` is removed; pass `--url URL` (or set `TALKIF_API_URL`) for another backend. `--env-file PATH` still picks the developer file.
- The developer file is now `~/.config/talkif/dev.env`; its `TALKIF_API_URL` is optional (empty means Talkif), and the `apiUrl` option beats it.

## 0.21.1 — 2026-10-16

- README rewritten for new users: what call-me is, what you need first, setup in 3 steps with the expected `/cm setup` output, spoken examples, safety, commands, options and troubleshooting.
- Plugin and marketplace descriptions are one plain sentence; the marketplace owner is Talkif.
- The `debug` option's description names `/cm traffic` (the old `/call-me-traffic` name is gone).
- Internal details removed from code comments, tests and this changelog. Test secrets are obviously fake.

## 0.21.0 — 2026-10-16

- New `/cm setup`: checks your API key, the connection to Talkif, whether Connectors are turned on for your account, the key's scopes and the flow your calls use, and prints the next step for the first thing missing. It only reads and never prints the key.
- The connector scripts (knowledge folder, launcher, local agent) use Talkif by default, take `--url` for another backend, and read the key from `$TALKIF_API_KEY` (or `--key-env VAR`).
- **Breaking for the scripts:** a developer file path goes in `--env-file`. `--key VAR` still works as the old name of `--key-env`.
- The launcher no longer passes its key to the Claude Code runs it starts, and `--cwd` defaults to the current folder.

## 0.20.0 — 2026-10-16

- Set up from the plugin options: `apiKey` (kept in the keychain), `environment`, `flowId` and `folders`.
- With `flowId` empty, the plugin picks the first published flow with a Connectors node and remembers it.
- Every session can join (before, only sessions in one fixed folder). The `folders` option limits it.
- Clear setup messages for a missing key, a missing scope, Connectors not turned on, and no Connectors flow.

## 0.19.3 — 2026-10-15

- Read-only call tasks: credential files can no longer be reached through shell wildcards, braces, `..` or git revision paths (`git show HEAD:.env`). More credential locations are covered (`~/.kube`, `~/.docker`, `~/.gnupg`, `~/.config/gh`, `secrets/`, `*.env`, `.npmrc`, `.pypirc`, SSH keys).
- Text from a call can no longer close the fence around it with spaced or HTML-escaped tags.
- The connector scripts send the `talkif-call-me/<version>` User-Agent too.

## 0.19.2 — 2026-10-15

- A finished call's transcript now runs as a call task, so read-only mode applies to it.
- Text from calls (transcripts, call notes, relayed questions) reaches the model marked as untrusted data, never as instructions.
- Read-only call tasks do not read credential files (`~/.ssh`, `~/.aws`, `.env` files, keys and similar).
- Requests send a `talkif-call-me/<version>` User-Agent.

## 0.19.1 — 2026-10-15

- Read-only call tasks are an allowlist: only reading tools work; everything else (web fetches, MCP tools, publishes, messages, schedules) is refused.
- Call tasks cannot escape read-only mode through background commands, remote agents or subagents.
- Text that looks like a secret is replaced with `[redacted]` in everything the plugin sends.

## 0.19.0 — 2026-10-15

- Tasks from a call run read-only by default. New option `callTasks`: `read-only` or `session` (the session's own permissions).
- The voice agent and sessions are told never to say secrets.
- Connectors have an audience: coding sessions and the launcher are private; a knowledge folder takes `--audience private|team|public`.
- Debug, parallel and callback settings moved to the plugin options.

## 0.18.0 — 2026-10-14

- Experimental local agent (`connectors/agent.mjs`) that holds a WebSocket per session instead of long polling. Not needed.
- `/cm off all` takes effect within about 2 seconds.

## 0.17.0 — 2026-10-14

- Coding sessions are private: teammates cannot reach them.
- Commands moved under `/cm`: `/cm traffic`, `/cm publish`, `/cm latency`.
- `/cm publish` writes the call instructions into the flow's Connectors node.

## 0.16.1 — 2026-10-14

- Say how you want a late result ("call me when it's done" or "just tell me next time") and the agent remembers it.

## 0.16.0 — 2026-10-14

- Summaries of your last three calls reach every session.
- Sessions refresh their recap when a call starts.
- When it is unclear which session a request is for, the best-fitting session takes it.

## 0.15.0 — 2026-10-14

- The plugin never grants a permission. A call task waiting at a permission prompt tells you on the call, or rings you.

## 0.14.0 — 2026-10-14

- Plugin options: `debug`, `parallel`, `callback`.

## 0.13.0 — 2026-10-14

- `/cm` turns call-me on or off for this session, all sessions, or new sessions.

## 0.12.0 — 2026-10-14

- Ring-back: a task from a call that finishes or gets stuck after you hung up rings you with the result.

## 0.11.0 — 2026-10-14

- The voice agent says in one sentence what task it sends, and sends it without asking for confirmation.

## 0.10.0 — 2026-10-14

- A request that names a session ("the docs session") goes straight to it.
- Clearer call instructions for the voice agent.

## 0.9.0 — 2026-10-13

- Better call behaviour: "pass it" sends at once, misheard names are understood, no repeats, the agent speaks your language.

## Connector scripts

- `connectors/knowledge-folder.mjs`: answers questions from a folder of documents.
- `connectors/launcher.mjs`: answers questions with a read-only Claude Code run (plan mode).

## 0.8.0 — 2026-10-13

- Debug pane showing this session's call-me traffic live.

## 0.7.0 — 2026-10-13

- The session confirms a question the moment it arrives, so the agent can say it is working on it; a slow answer arrives as a note.
- Several questions are handled at once.
- While a task runs, a new one is declined ("still on the last task"), or queued with the `parallel` option.

## 0.6.1 — 2026-10-13

- The voice agent never asks you which session you mean.

## 0.6.0 — 2026-10-13

- Sessions describe themselves by their git repository, so the agent can route by project.

## 0.5.0 — 2026-10-13

- When the agent cannot tell which session a request is for, the session it fits takes it.

## 0.4.0 — 2026-10-13

- A session can join several Talkif accounts at once.

## 0.3.3 — 2026-10-13

- A single dropped connection no longer prints a message.

## 0.3.2 — 2026-10-13

- Session recaps cost much less and refresh every 15 minutes.
- The call hangs up as soon as you say to close it.

## 0.3.1 — 2026-10-13

- A restarted session no longer shows twice.
- A session leaves at once when it exits.
- New sessions are reachable right after they start.

## 0.3.0 — 2026-10-13

- First release: a session can ring your phone with questions, take instructions during a call, report when it is done, and gets back only its own calls.
