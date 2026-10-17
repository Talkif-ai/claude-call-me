// The tier of one tool call a peer task wants to run: what it could do, from
// reading only to deploying to production. Deterministic, no engine calls; the
// same cases (test-vectors/tiers.json) are checked by every client and by the
// hub, which reclassifies each approval and keeps the stricter tier.
//
// Rank, stricter is higher: read(0) < local_write(1) < outward(2) <
// irreversible(3) < unsure(4) < secret(5) < money(6) < prod_deploy(7).
// Every rule that matches raises the tier; the highest wins. Anything this file
// does not know is `unsure` (asked, never run on its own).
//
// `local_write` means "changes inside the folder, judged by Claude Code's own
// permission mode or sandbox". It includes running the project's own programs
// (builds, tests, installs), which can do anything those programs do: the floor
// here covers direct outward commands, not what a build script does.

import { isCredentialAncestor, isCredentialPath, namesCredentialPath, readOnlyDenial, recursiveTargets, resolvePath, targetsCredentialAncestor } from './read-only'

export const TIERS = ['read', 'local_write', 'outward', 'irreversible', 'unsure', 'secret', 'money', 'prod_deploy'] as const
export type Tier = (typeof TIERS)[number]

export const rank = (t: Tier): number => TIERS.indexOf(t)
export const stricter = (a: Tier, b: Tier): Tier => (rank(a) >= rank(b) ? a : b)

/** Tiers whose approval needs the owner's passkey (owner proof), never a terminal yes. */
export const needsOwnerProof = (t: Tier): boolean => rank(t) >= rank('outward') && t !== 'unsure'
/** Tiers a terminal answer (the plugin's own prompt) may approve. */
export const terminalMayApprove = (t: Tier): boolean => t === 'local_write' || t === 'unsure'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// Tools that only read, or only touch the session's own task list (as read-only.ts).
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'LSP', 'NotebookRead', 'ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const MONEY_NAME = /stripe|payment|charge|invoice|refund/i
const OUTWARD_NAME = /send|post|publish/i
const SQL_TOOL = /sql|postgres|mysql|sqlite|database|\bdb\b|_db_|db_/i

// Paths under the person's home that hold their agents' and tools' own secrets.
const HOME_SECRET = /^(?:~|\/(?:Users|home)\/[^/]+|\/root)\/(?:\.claude(?:\/|$)|\.claude\.json$|\.config\/talkif(?:\/|$))/

// Files inside a repo that make something run later, outside this task's sight:
// git hooks and config, editor tasks, direnv, hook managers, agent settings and
// MCP servers. Changing one is never ordinary local work.
const RUNS_LATER = /(?:^|\/)(?:\.git(?:\/|$)|\.claude(?:\/|$)|\.mcp\.json$|\.envrc$|\.vscode(?:\/|$)|\.idea(?:\/|$)|\.husky(?:\/|$)|\.gemini(?:\/|$)|\.codex(?:\/|$)|\.cursor(?:\/|$)|\.gitmodules$|\.pre-commit-config\.ya?ml$)/
// As strict as a secret (the shared table's v2 says so too): anything in .git, an
// agent's own settings (permission rules, hooks), MCP servers, direnv, editor and
// agent config folders.
const AGENT_SETTINGS = /(?:^|\/)(?:\.git(?:\/|$)|\.claude\/settings[^/]*$|\.mcp\.json$|\.envrc$|\.vscode(?:\/|$)|\.gemini(?:\/|$)|\.codex(?:\/|$)|\.cursor(?:\/|$))/

/** Whether `path` (as written, relative to `root`) stays inside `root`, root itself excluded. */
export function insideRoot(path: string, root: string): boolean {
  const base = root.replace(/\/+$/, '')
  const p = path.replace(/["']/g, '')
  if (!p || p.startsWith('~') || /[*?[{]/.test(p)) return false
  const abs = p.startsWith('/') ? p : `${base}/${p}`
  const parts: string[] = []
  for (const part of abs.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return false
      parts.pop()
    } else parts.push(part)
  }
  const resolved = `/${parts.join('/')}`
  return resolved.startsWith(`${base}/`) && resolved !== base
}

const pathIsSecret = (path: string): boolean => isCredentialPath(path) || HOME_SECRET.test(path.replace(/["']/g, ''))

// ---- where the shell runs ----
// A relative path means a different file in another folder. The shell's folder is
// the session root unless a `cd` moved it: earlier in the same command line, or in
// an earlier Bash call (the Bash tool keeps its folder between calls). `cwds` is
// every folder the shell may be in; undefined means one this file cannot know.

export type Cwds = readonly (string | undefined)[]
const MAX_CWDS = 8

const within = (abs: string, root: string): boolean => abs === root || abs.startsWith(`${root}/`)

/** Every folder of `cwds`, or undefined for one outside `root` or not known. */
const keepInside = (cwds: Cwds, root: string): (string | undefined)[] => cwds.map(c => (c !== undefined && within(c, root) ? c : undefined))

const union = (a: Cwds, b: Cwds): (string | undefined)[] => {
  const out = [...new Set([...a, ...b])]
  return out.length > MAX_CWDS ? [undefined] : out
}

/** Whether `path` names something inside `root` (root itself excluded) from every folder in `cwds`. */
const insideFrom = (path: string, cwds: Cwds, root: string): boolean =>
  !/[*?[{]/.test(path) &&
  cwds.every(base => {
    const abs = resolvePath(base, path)
    return abs !== undefined && !abs.startsWith('~') && within(abs, root) && abs !== root
  })

const CD = new Set(['cd', 'pushd', 'popd', 'chdir'])

/** The folders a `cd`-like segment leaves the shell in: unknown for `cd`, `cd -`, `cd ~`, `popd`. */
function cdTargets(ws: readonly string[], cwds: Cwds, root: string): (string | undefined)[] {
  const prog = ws[0] ?? ''
  const target = ws.slice(1).find(w => !w.startsWith('-') || w === '-')
  if (prog === 'popd' || target === undefined || target === '-') return [undefined]
  return keepInside(cwds.map(base => resolvePath(base, target)).map(abs => (abs?.startsWith('~') ? undefined : abs)), root)
}

/** Where the shell may be after `command` ran, given where it may have been (the Bash tool keeps its folder). */
export function shellCwdsAfter(command: string, cwds: Cwds, root: string): (string | undefined)[] {
  const line = command.replace(QUIET, ' ').trim()
  // A subshell, substitution or escape: the parts are not the whole story.
  if (UNSAFE.test(line)) return /\bcd\b|\bpushd\b|\bpopd\b/.test(line) ? union(cwds, [undefined]) : [...cwds]
  const parts = line.split(/(\|\||&&|[|;\n&])/)
  let now: (string | undefined)[] = [...cwds]
  for (let i = 0; i < parts.length; i += 2) {
    const ws = words(parts[i] ?? '')
    if (!CD.has(ws[0] ?? '')) continue
    // The command may stop before this cd, or the cd may fail: both folders stay possible.
    now = union(now, cdTargets(ws, now, root))
  }
  return union(cwds, now)
}

// ---- Bash ----

const UNSAFE = /[<>`()$\\\r]/
const QUIET = /\s2>(?:&1|\/dev\/null)(?=\s|$)/g

const words = (segment: string): string[] => segment.trim().split(/\s+/).filter(Boolean)

const WRAPPERS = ['sudo', 'command', 'nohup', 'time', 'exec']
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const leadingCount = (ws: readonly string[]): number => {
  // Leading VAR=value assignments and `sudo`/`command`/`nohup`/`time`/`exec` wrappers.
  let i = 0
  while (i < ws.length && (ASSIGNMENT.test(ws[i] ?? '') || WRAPPERS.includes(ws[i] ?? ''))) i++
  return i
}
const programOf = (ws: readonly string[]): string => (ws[leadingCount(ws)] ?? '').split('/').pop() ?? ''
const argsOf = (ws: readonly string[]): string[] => ws.slice(leadingCount(ws) + 1)

// Environment names that only change output or logging. Any other name set in front
// of a command (GIT_SSH_COMMAND, LD_PRELOAD, NODE_OPTIONS, PATH, PAGER, …) can make
// the command run another program, so it is unsure.
const HARMLESS_ENV = /^(?:RUST_LOG|RUST_BACKTRACE|NODE_ENV|CI|DEBUG|LOG_LEVEL|TZ|LANG|LC_[A-Z]+|NO_COLOR|FORCE_COLOR|TERM|COLUMNS|PYTHONUNBUFFERED|PYTHONDONTWRITEBYTECODE)=/
const riskyAssignment = (w: string): boolean => ASSIGNMENT.test(w) && !HARMLESS_ENV.test(w)

const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'perl', 'deno', 'bun', 'osascript', 'php', 'lua', 'Rscript'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh'])
const EVAL_FLAG = /^(?:-e|-p|-c|-E|-r|--eval|--print|--command|eval)$/

const AWS_MUTATING = /^(?:create|delete|put|update|modify|terminate|run|start|stop|attach|detach|associate|disassociate|deregister|register|remove|add|set|tag|untag|reboot|restore|invoke|publish|send|deploy|import|copy|reset|enable|disable|revoke|authorize|replace|rotate|cancel|apply|execute|purchase|release|allocate|accept|reject)(?:-|$)/
const S3_MUTATING = new Set(['cp', 'mv', 'rm', 'sync', 'rb', 'mb', 'presign'])

// Programs that build, test, format or edit inside the working tree.
const LOCAL_PROGRAMS = new Set([
  'cd', 'pushd', 'export', 'unset', 'cargo', 'rustc', 'rustfmt', 'make', 'cmake', 'ninja', 'just', 'yarn', 'pnpm', 'npm', 'bun', 'node', 'tsc', 'tsx', 'deno',
  'python', 'python3', 'pip', 'pip3', 'uv', 'poetry', 'pytest', 'ruff', 'black', 'mypy', 'isort', 'go', 'gofmt', 'swift', 'xcodebuild',
  'gradle', 'mvn', 'javac', 'java', 'dotnet', 'mix', 'elixir', 'ruby', 'bundle', 'rake', 'rspec', 'prettier', 'eslint', 'biome', 'jest', 'vitest',
  'mkdir', 'touch', 'cp', 'mv', 'rm', 'ln', 'sed', 'awk', 'sort', 'uniq', 'tr', 'cut', 'echo', 'printf', 'true', 'false', 'test', 'diff',
  'find', 'xxd', 'jq', 'yq', 'tar', 'gzip', 'gunzip', 'zip', 'unzip', 'chmod', 'date', 'basename', 'dirname', 'realpath', 'which', 'tee',
  'cat', 'head', 'tail', 'grep', 'rg', 'ls', 'pwd', 'wc', 'file', 'stat', 'du', 'df', 'tree', 'sleep', 'claude',
])
const WRITERS = new Set(['cp', 'ln', 'touch', 'mkdir', 'chmod', 'chown', 'tee', 'sed', 'tar', 'unzip', 'install', 'truncate', 'dd'])
// Git subcommands that only change the working tree, the index or local refs. Not
// here (so unsure): config (core.fsmonitor, core.sshCommand, aliases run programs,
// --global writes outside the repo), submodule (foreach runs commands), worktree
// and init (write outside the repo), and anything not listed.
const GIT_LOCAL = new Set(['status', 'log', 'diff', 'show', 'add', 'commit', 'checkout', 'switch', 'restore', 'stash', 'rebase', 'cherry-pick', 'tag', 'branch', 'mv', 'rm', 'fetch', 'pull', 'blame', 'grep', 'rev-parse', 'ls-files', 'describe', 'reflog', 'apply', 'am', 'format-patch', 'notes', 'remote', 'reset', 'clean'])
// Git options that run a program or write a file outside the tree.
const GIT_RUNS = /^(?:--output(?:=.*)?|--ext-diff|--upload-pack(?:=.*)?|--receive-pack(?:=.*)?|--exec-path(?:=.*)?|--config-env(?:=.*)?|--template(?:=.*)?)$/
const GIT_REMOTE_READ = new Set(['-v', '--verbose', 'show', 'get-url'])
// Options of ordinary tools that run a program of the caller's choice.
const RUNS_PROGRAM: Readonly<Record<string, RegExp>> = {
  sort: /^--compress-program(?:=.*)?$/,
  tar: /^(?:-I.*|-[a-zA-Z]*I|-F.*|--use-compress-program(?:=.*)?|--to-command(?:=.*)?|--checkpoint-action(?:=.*)?|--info-script(?:=.*)?|--new-volume-script(?:=.*)?|-H|--rmt-command(?:=.*)?|--rsh-command(?:=.*)?)$/,
  zip: /^(?:-TT.*|--unzip-command(?:=.*)?)$/,
  rsync: /^(?:-e.*|-[a-zA-Z]*e|--rsh(?:=.*)?|--rsync-path(?:=.*)?)$/,
  find: /^-(?:exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/,
}
// sed's `e` command or flag runs a shell command; `w`/`W` writes a file.
const SED_RUNS = /(?:^|[;{}\s])[ewW](?:\s|$)|\/[gpIiMm0-9]*[ewW][gpIiMm0-9]*(?:\s|$)/
// Options that run the command in another folder, for the programs that take one.
const DIR_FLAGS = new Set(['-C', '--directory', '--cwd', '--prefix', '--manifest-path', '--dir', '--project-dir', '--chdir'])
const DIR_PROGRAMS = new Set(['make', 'cargo', 'npm', 'yarn', 'pnpm', 'bun', 'tar', 'just', 'ninja', 'cmake', 'go', 'uv', 'poetry', 'pip', 'pip3', 'mvn', 'gradle', 'dotnet', 'swift', 'xcodebuild', 'deno', 'unzip', 'zip'])

function segmentTier(segment: string, root: string, cwds: Cwds): Tier {
  const ws = words(segment)
  const prog = programOf(ws)
  const args = argsOf(ws)
  const joined = args.join(' ')
  if (!prog) return 'read'
  let tier: Tier = 'read'
  const raise = (t: Tier) => {
    tier = stricter(tier, t)
  }
  const known = cwds.every(c => c !== undefined)

  // prod_deploy
  if (prog === 'kubectl' || prog === 'argocd' || prog === 'kubectx' || prog === 'eksctl') raise('prod_deploy')
  if (prog === 'terraform' || prog === 'tofu') {
    const sub = args.find(a => !a.startsWith('-'))
    if (sub === undefined || !['fmt', 'validate', 'plan'].includes(sub)) raise('prod_deploy')
  }
  if (prog === 'helm' && args.some(a => ['install', 'upgrade', 'uninstall', 'rollback', 'delete'].includes(a))) raise('prod_deploy')
  if (prog === 'gh' && args[0] === 'workflow' && (args[1] === 'run' || args[1] === 'dispatch' || args[1] === 'enable')) raise('prod_deploy')
  if (/deploy|promote|rollback/i.test(prog)) raise('prod_deploy')
  if (['make', 'just', 'yarn', 'pnpm', 'npm', 'bun', 'npx'].includes(prog) && args.some(a => /deploy|promote|rollback/i.test(a))) raise('prod_deploy')
  if (prog === 'gh' && args[0] === 'workflow' && /deploy|promote|rollback/i.test(joined)) raise('prod_deploy')
  if (prog === 'aws') {
    const positional = args.filter(a => !a.startsWith('-'))
    const [service, op] = positional
    if (service === 's3' ? op !== undefined && S3_MUTATING.has(op) : op !== undefined && AWS_MUTATING.test(op)) raise('prod_deploy')
    else if (op === undefined) raise('unsure')
  }

  // money
  if (prog === 'stripe') raise('money')
  if ((prog === 'curl' || prog === 'wget') && /api\.stripe\.com/i.test(joined)) raise('money')

  // secret
  if (prog === 'security' && args.some(a => /^(?:find-generic-password|find-internet-password|dump-keychain|export|dump-trust-settings)$/.test(a))) raise('secret')
  if (prog === 'printenv' || (prog === 'env' && args.every(a => a.startsWith('-'))) || (prog === 'set' && args.length === 0) || prog === 'export' && args.length === 0) raise('secret')
  if (/\/proc\/[^\s/]*\/environ/.test(segment)) raise('secret')
  if (prog === 'gh' && args[0] === 'auth' && args[1] === 'token') raise('secret')
  if (prog === 'git' && args[0] === 'credential') raise('secret')
  if (namesCredentialPath(segment) || ws.some(w => w.split(/[=:]/).some(pathIsSecret))) raise('secret')
  // A recursive reader over the home folder, ~/.config or / reads the credential folders in it.
  const targets = recursiveTargets(ws)
  if (targets !== undefined && targetsCredentialAncestor(targets, cwds)) raise('secret')

  // outward
  if (prog === 'git' && (args[0] === 'push' || args[0] === 'merge' || args[0] === 'send-email' || args[0] === 'request-pull')) raise('outward')
  if (prog === 'gh' && ((args[0] === 'pr' && ['merge', 'create', 'close', 'comment', 'review', 'edit', 'ready'].includes(args[1] ?? '')) || args[0] === 'release' || (args[0] === 'issue' && ['create', 'close', 'comment', 'edit', 'delete'].includes(args[1] ?? '')) || args[0] === 'api' || args[0] === 'repo' && ['create', 'delete', 'edit', 'fork', 'rename', 'archive'].includes(args[1] ?? ''))) raise('outward')
  if (['npm', 'yarn', 'pnpm', 'bun', 'cargo', 'twine', 'gem', 'poetry'].includes(prog) && args.includes('publish')) raise('outward')
  if (prog === 'ssh' || prog === 'scp' || prog === 'sftp' || prog === 'ftp' || prog === 'telnet' || prog === 'nc' || prog === 'ncat') raise('outward')
  if (prog === 'rsync' && args.some(a => !a.startsWith('-') && /^[^/]*:/.test(a))) raise('outward')
  if (prog === 'curl' || prog === 'wget') {
    const sends = args.some(a => /^(?:-d|--data.*|-F|--form.*|-T|--upload-file|--json|--post-data|--post-file|-X|--request|--method)(?:=|$)/.test(a) || /^-[a-zA-Z]*[dFTX]/.test(a))
    const nonGet = /(?:-X|--request|--method)\s*=?\s*(?!GET\b)\S+/i.test(joined)
    raise(sends || nonGet ? 'outward' : 'unsure')
  }
  if (prog === 'docker' && ['push', 'login'].includes(args[0] ?? '')) raise('outward')

  // irreversible: deleting or moving anything not provably inside the folder, from
  // every folder the shell may be in.
  if (prog === 'rm' || prog === 'mv' || prog === 'rmdir' || prog === 'shred' || prog === 'unlink') {
    const paths = args.filter(a => !a.startsWith('-'))
    if (paths.length === 0 || paths.some(p => !insideFrom(p, cwds, root))) raise('irreversible')
  }
  if (prog === 'git' && args[0] === 'reset' && args.includes('--hard')) raise('irreversible')
  if (prog === 'git' && args[0] === 'clean' && args.some(a => /^-[a-zA-Z]*f/.test(a) || a === '--force')) raise('irreversible')
  if (prog === 'git' && args[0] === 'branch' && args.some(a => a === '-D' || (a.startsWith('-') && a.includes('D')) || a === '--delete' && args.includes('--force'))) raise('irreversible')
  if (prog === 'git' && args[0] === 'push' && args.some(a => a === '--force' || a === '-f' || a.startsWith('--force-with-lease'))) raise('irreversible')
  if (/\b(?:DROP|TRUNCATE)\b/i.test(segment) && ['psql', 'mysql', 'sqlite3', 'sqlx', 'mongosh', 'redis-cli'].includes(prog)) raise('irreversible')
  if (prog === 'redis-cli' && /\bFLUSH(?:ALL|DB)\b/i.test(joined)) raise('irreversible')

  // unsure: code from the command line, shells, wrappers that run other commands
  if (INTERPRETERS.has(prog) && args.some(a => EVAL_FLAG.test(a))) raise('unsure')
  if (SHELLS.has(prog)) raise('unsure')
  if (prog === 'eval' || prog === 'source' || prog === '.' || prog === 'xargs' || prog === 'env' && args.some(a => !a.startsWith('-')) || prog === 'parallel' || prog === 'watch') raise('unsure')
  // An environment that can make the command run another program (GIT_SSH_COMMAND, LD_PRELOAD, PATH, …).
  if (ws.slice(0, leadingCount(ws)).some(riskyAssignment)) raise('unsure')
  if (['export', 'declare', 'typeset', 'alias', 'setopt'].includes(prog) && args.some(a => a === '-f' || riskyAssignment(a) || !ASSIGNMENT.test(a))) raise('unsure')
  // Options that run a program of the caller's choice.
  const runs = RUNS_PROGRAM[prog]
  if (runs && args.some(a => runs.test(a))) raise('unsure')
  if ((prog === 'sed' || prog === 'gsed') && args.some(a => !a.startsWith('-') && SED_RUNS.test(a.replace(/["']/g, '')))) raise('unsure')
  if (prog === 'git') {
    if (args.some(a => GIT_RUNS.test(a))) raise('unsure')
    if (args[0] === 'rebase' && args.some(a => a === '-x' || a.startsWith('--exec'))) raise('unsure')
    if (args[0] === 'grep' && args.some(a => /^-O/.test(a) || a.startsWith('--open-files-in-pager'))) raise('unsure')
    // A changed remote makes a later, approved `git push origin` go somewhere else: as outward as the push.
    if (args[0] === 'remote' && (args[1] === 'add' || args[1] === 'set-url')) raise('outward')
    else if (args[0] === 'remote' && args[1] !== undefined && !GIT_REMOTE_READ.has(args[1])) raise('unsure')
    // git config can set hooks, the ssh program, aliases, remotes: approved with the passkey only.
    if (args[0] === 'config') raise('secret')
  }
  // Another folder than this one.
  args.forEach((a, i) => {
    const eq = a.indexOf('=')
    const flag = eq > 0 ? a.slice(0, eq) : a
    const value = eq > 0 ? a.slice(eq + 1) : args[i + 1]
    if (DIR_PROGRAMS.has(prog) && DIR_FLAGS.has(flag) && value !== undefined && !cwds.every(base => {
      const abs = resolvePath(base, value)
      return abs !== undefined && within(abs, root)
    })) raise('unsure')
  })

  // Programs that write files: a path outside the working tree makes it unsure.
  if (WRITERS.has(prog) && args.some(a => !a.startsWith('-') && (a.startsWith('/') || a.startsWith('~') || a.includes('..') || !known) && !insideFrom(a, cwds, root))) raise('unsure')

  // local work and reading
  if (tier === 'read') {
    if (prog === 'git') {
      const sub = args.find(a => !a.startsWith('-'))
      if (args[0]?.startsWith('-')) raise('unsure') // `git -c …` can run a configured program
      else if (sub === undefined || !GIT_LOCAL.has(sub)) raise('unsure')
      else if (readOnlyDenial({ tool: 'Bash', command: segment }) !== undefined) raise('local_write')
    } else if (readOnlyDenial({ tool: 'Bash', command: segment }) === undefined) {
      // a plain reader
    } else if (LOCAL_PROGRAMS.has(prog)) raise('local_write')
    else raise('unsure')
  }
  if (tier !== 'read' && rank(tier) < rank('unsure')) {
    // Changing a file that runs later (git hooks and config, agent settings, editor tasks).
    const named = ws.flatMap(w => [w, ...w.split(/[=:]/)]).map(w => w.replace(/["']/g, ''))
    if (named.some(w => AGENT_SETTINGS.test(w))) raise('secret')
    else if (named.some(w => RUNS_LATER.test(w))) raise('unsure')
  }
  // Local work in a folder that may be outside this one is not local work, nor
  // work in a folder whose files run later (`cd .git/hooks && cp x pre-commit`).
  // (`now()`: `raise` changes `tier` inside a closure, which narrowing does not follow.)
  const now = (): Tier => tier
  if (now() === 'local_write' && (!known || cwds.some(c => c !== undefined && RUNS_LATER.test(c.slice(root.length))))) raise('unsure')
  // Reading by a relative name in a folder not known: it may be a credential folder.
  if (now() === 'read' && !known && args.some(a => !a.startsWith('-') && !a.startsWith('/'))) raise('unsure')
  return tier
}

export function bashTier(command: string, root: string, cwds: Cwds = [root]): Tier {
  const line = command.replace(QUIET, ' ').trim()
  if (!line) return 'unsure'
  const start = keepInside(cwds, root)
  // Simple commands and the operator after each: `|` pipes it into the next.
  const parts = line.split(/(\|\||&&|[|;\n&])/)
  let tier: Tier = 'read'
  let now: (string | undefined)[] = start
  for (let i = 0; i < parts.length; i += 2) {
    const segment = parts[i] ?? ''
    if (!segment.trim()) continue
    const ws = words(segment)
    if (CD.has(programOf(ws))) {
      // `cd` to a folder outside this one (or one not known): what follows runs elsewhere.
      const after = cdTargets(ws.slice(leadingCount(ws)), now, root)
      tier = stricter(tier, after.some(c => c === undefined) || ws.slice(0, leadingCount(ws)).some(riskyAssignment) ? 'unsure' : 'local_write')
      // After `&&` only the moved shell runs on; after `;`, `|` or `||` either may.
      now = parts[i + 1] === '&&' ? after : parts[i + 1] === '||' ? now : union(now, after)
      continue
    }
    tier = stricter(tier, segmentTier(segment, root, now))
    // Piped into a shell or an interpreter: what comes before it is code.
    const next = parts[i + 2]
    if (parts[i + 1] === '|' && next !== undefined) {
      const prog = programOf(words(next))
      if (SHELLS.has(prog) || INTERPRETERS.has(prog)) tier = stricter(tier, 'unsure')
    }
  }
  // Commands inside substitutions, subshells and `sh -c '…'` / `eval '…'` count as
  // commands of their own (a `kubectl` there is still a deploy).
  for (const m of line.matchAll(/\$\(([^()]*)\)|`([^`]*)`|\(([^()]*)\)/g)) tier = stricter(tier, bashTier(m[1] ?? m[2] ?? m[3] ?? '', root, start))
  for (const m of line.matchAll(/(?:\b(?:ba|z|da|k|fi)?sh|\beval|\bxargs|\bwatch)\s+(?:-\w+\s+)*(["'])([\s\S]*?)\1/g)) tier = stricter(tier, bashTier(m[2] ?? '', root, start))
  // Substitutions, redirections, escapes, background jobs: the parts above are
  // not the whole story, so at least unsure (stricter rules above still count).
  if (UNSAFE.test(line) || /(?:^|[^&])&(?!&)/.test(line)) tier = stricter(tier, 'unsure')
  return tier
}

/**
 * The tier of one tool call; `root` is the session's folder. `cwds`: every folder
 * the Bash tool's shell may be in (undefined: not known); the root when omitted.
 */
export function classify(tool: string, input: unknown, root: string, cwds: Cwds = [root]): Tier {
  const i = isRecord(input) ? input : {}
  if (tool === 'Bash') return i.run_in_background === true ? stricter(bashTier(str(i.command), root, cwds), 'unsure') : bashTier(str(i.command), root, cwds)
  const path = str(i.file_path) || str(i.notebook_path) || str(i.path) || str(i.filePath)
  if (path && pathIsSecret(path)) return 'secret'
  // Grep and Glob over the home folder, ~/.config or / reach the credential folders.
  if ((tool === 'Grep' || tool === 'Glob') && (path ? isCredentialAncestor(resolvePath(root, path) ?? '/') : isCredentialAncestor(root))) return 'secret'
  if (READ_TOOLS.has(tool)) return 'read'
  if (tool === 'Agent') return i.isolation === 'remote' || i.run_in_background === true ? 'unsure' : 'read'
  if (EDIT_TOOLS.has(tool)) {
    if (path && AGENT_SETTINGS.test(path)) return 'secret'
    if (path && RUNS_LATER.test(path)) return 'unsure'
    return path && insideRoot(path, root) ? 'local_write' : 'unsure'
  }
  // Tools by name: payments, then sending; anything else is unknown.
  if (MONEY_NAME.test(tool)) return 'money'
  if (SQL_TOOL.test(tool) && /\b(?:DROP|TRUNCATE)\b/i.test(JSON.stringify(input) ?? '')) return 'irreversible'
  if (OUTWARD_NAME.test(tool)) return 'outward'
  return 'unsure'
}
