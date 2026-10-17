// The tier of one tool call a peer task wants to run: what it could do, from
// reading only to deploying to production. Deterministic, no engine calls; the
// same cases (test-vectors/tiers.json) are checked by every client and by the
// hub, which reclassifies each approval and keeps the stricter tier.
//
// Rank, stricter is higher: read(0) < local_write(1) < outward(2) <
// irreversible(3) < unsure(4) < secret(5) < money(6) < prod_deploy(7).
// Every rule that matches raises the tier; the highest wins. Anything this file
// does not know is `unsure` (asked, never run on its own).

import { isCredentialPath, namesCredentialPath, readOnlyDenial } from './read-only'

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

// ---- Bash ----

const UNSAFE = /[<>`()$\\\r]/
const QUIET = /\s2>(?:&1|\/dev\/null)(?=\s|$)/g

const words = (segment: string): string[] => segment.trim().split(/\s+/).filter(Boolean)
const programOf = (ws: readonly string[]): string => {
  // Skip leading VAR=value assignments and `sudo`/`env`/`command`/`nohup` wrappers.
  let i = 0
  while (i < ws.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i] ?? '') || ['sudo', 'command', 'nohup', 'time', 'exec'].includes(ws[i] ?? ''))) i++
  return (ws[i] ?? '').split('/').pop() ?? ''
}
const argsOf = (ws: readonly string[]): string[] => {
  let i = 0
  while (i < ws.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i] ?? '') || ['sudo', 'command', 'nohup', 'time', 'exec'].includes(ws[i] ?? ''))) i++
  return ws.slice(i + 1)
}

const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'perl', 'deno', 'bun', 'osascript', 'php', 'lua', 'Rscript'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh'])
const EVAL_FLAG = /^(?:-e|-p|-c|-E|-r|--eval|--print|--command|eval)$/

const AWS_MUTATING = /^(?:create|delete|put|update|modify|terminate|run|start|stop|attach|detach|associate|disassociate|deregister|register|remove|add|set|tag|untag|reboot|restore|invoke|publish|send|deploy|import|copy|reset|enable|disable|revoke|authorize|replace|rotate|cancel|apply|execute|purchase|release|allocate|accept|reject)(?:-|$)/
const S3_MUTATING = new Set(['cp', 'mv', 'rm', 'sync', 'rb', 'mb', 'presign'])

// Programs that build, test, format or edit inside the working tree.
const LOCAL_PROGRAMS = new Set([
  'cd', 'export', 'unset', 'cargo', 'rustc', 'rustfmt', 'make', 'cmake', 'ninja', 'just', 'yarn', 'pnpm', 'npm', 'bun', 'node', 'tsc', 'tsx', 'deno',
  'python', 'python3', 'pip', 'pip3', 'uv', 'poetry', 'pytest', 'ruff', 'black', 'mypy', 'isort', 'go', 'gofmt', 'swift', 'xcodebuild',
  'gradle', 'mvn', 'javac', 'java', 'dotnet', 'mix', 'elixir', 'ruby', 'bundle', 'rake', 'rspec', 'prettier', 'eslint', 'biome', 'jest', 'vitest',
  'mkdir', 'touch', 'cp', 'mv', 'rm', 'ln', 'sed', 'awk', 'sort', 'uniq', 'tr', 'cut', 'echo', 'printf', 'true', 'false', 'test', 'diff',
  'find', 'xxd', 'jq', 'yq', 'tar', 'gzip', 'gunzip', 'zip', 'unzip', 'chmod', 'date', 'basename', 'dirname', 'realpath', 'which', 'tee',
  'cat', 'head', 'tail', 'grep', 'rg', 'ls', 'pwd', 'wc', 'file', 'stat', 'du', 'df', 'tree', 'sleep', 'claude',
])
const WRITERS = new Set(['cp', 'ln', 'touch', 'mkdir', 'chmod', 'chown', 'tee', 'sed', 'tar', 'unzip', 'install', 'truncate', 'dd'])
const GIT_LOCAL = new Set(['status', 'log', 'diff', 'show', 'add', 'commit', 'checkout', 'switch', 'restore', 'stash', 'rebase', 'cherry-pick', 'tag', 'branch', 'mv', 'rm', 'init', 'fetch', 'pull', 'worktree', 'blame', 'grep', 'rev-parse', 'ls-files', 'describe', 'reflog', 'apply', 'am', 'format-patch', 'notes', 'config', 'remote', 'submodule', 'reset', 'clean'])

function segmentTier(segment: string, root: string): Tier {
  const ws = words(segment)
  const prog = programOf(ws)
  const args = argsOf(ws)
  const joined = args.join(' ')
  if (!prog) return 'read'
  let tier: Tier = 'read'
  const raise = (t: Tier) => {
    tier = stricter(tier, t)
  }

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

  // irreversible
  if (prog === 'rm' || prog === 'mv' || prog === 'rmdir' || prog === 'shred' || prog === 'unlink') {
    const paths = args.filter(a => !a.startsWith('-'))
    if (paths.length === 0 || paths.some(p => !insideRoot(p, root))) raise('irreversible')
  }
  if (prog === 'git' && args[0] === 'reset' && args.includes('--hard')) raise('irreversible')
  if (prog === 'git' && args[0] === 'clean' && args.some(a => /^-[a-zA-Z]*f/.test(a) || a === '--force')) raise('irreversible')
  if (prog === 'git' && args[0] === 'branch' && args.some(a => a === '-D' || (a.startsWith('-') && a.includes('D')) || a === '--delete' && args.includes('--force'))) raise('irreversible')
  if (prog === 'git' && args[0] === 'push' && args.some(a => a === '--force' || a === '-f' || a.startsWith('--force-with-lease'))) raise('irreversible')
  if (/\b(?:DROP|TRUNCATE)\b/i.test(segment) && ['psql', 'mysql', 'sqlite3', 'sqlx', 'mongosh', 'redis-cli'].includes(prog)) raise('irreversible')
  if (prog === 'redis-cli' && /\bFLUSH(?:ALL|DB)\b/i.test(joined)) raise('irreversible')
  if (prog === 'find' && args.some(a => a === '-delete' || a === '-exec' || a === '-execdir' || a === '-ok')) raise('unsure')

  // unsure: code from the command line, shells, wrappers that run other commands
  if (INTERPRETERS.has(prog) && args.some(a => EVAL_FLAG.test(a))) raise('unsure')
  if (SHELLS.has(prog)) raise('unsure')
  if (prog === 'eval' || prog === 'source' || prog === '.' || prog === 'xargs' || prog === 'env' && args.some(a => !a.startsWith('-')) || prog === 'parallel' || prog === 'watch') raise('unsure')

  // Programs that write files: a path outside the working tree makes it unsure.
  if (WRITERS.has(prog) && args.some(a => !a.startsWith('-') && (a.startsWith('/') || a.startsWith('~') || a.includes('..')) && !insideRoot(a, root))) raise('unsure')

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
  return tier
}

export function bashTier(command: string, root: string): Tier {
  const line = command.replace(QUIET, ' ').trim()
  if (!line) return 'unsure'
  // Simple commands and the operator after each: `|` pipes it into the next.
  const parts = line.split(/(\|\||&&|[|;\n&])/)
  let tier: Tier = 'read'
  for (let i = 0; i < parts.length; i += 2) {
    const segment = parts[i] ?? ''
    if (!segment.trim()) continue
    tier = stricter(tier, segmentTier(segment, root))
    // Piped into a shell or an interpreter: what comes before it is code.
    const next = parts[i + 2]
    if (parts[i + 1] === '|' && next !== undefined) {
      const prog = programOf(words(next))
      if (SHELLS.has(prog) || INTERPRETERS.has(prog)) tier = stricter(tier, 'unsure')
    }
  }
  // Commands inside substitutions, subshells and `sh -c '…'` / `eval '…'` count as
  // commands of their own (a `kubectl` there is still a deploy).
  for (const m of line.matchAll(/\$\(([^()]*)\)|`([^`]*)`|\(([^()]*)\)/g)) tier = stricter(tier, bashTier(m[1] ?? m[2] ?? m[3] ?? '', root))
  for (const m of line.matchAll(/(?:\b(?:ba|z|da|k|fi)?sh|\beval|\bxargs|\bwatch)\s+(?:-\w+\s+)*(["'])([\s\S]*?)\1/g)) tier = stricter(tier, bashTier(m[2] ?? '', root))
  // Substitutions, redirections, escapes, background jobs: the parts above are
  // not the whole story, so at least unsure (stricter rules above still count).
  if (UNSAFE.test(line) || /(?:^|[^&])&(?!&)/.test(line)) tier = stricter(tier, 'unsure')
  return tier
}

/** The tier of one tool call; `root` is the session's working directory. */
export function classify(tool: string, input: unknown, root: string): Tier {
  const i = isRecord(input) ? input : {}
  if (tool === 'Bash') return i.run_in_background === true ? stricter(bashTier(str(i.command), root), 'unsure') : bashTier(str(i.command), root)
  const path = str(i.file_path) || str(i.notebook_path) || str(i.path) || str(i.filePath)
  if (path && pathIsSecret(path)) return 'secret'
  if (READ_TOOLS.has(tool)) return 'read'
  if (tool === 'Agent') return i.isolation === 'remote' || i.run_in_background === true ? 'unsure' : 'read'
  if (EDIT_TOOLS.has(tool)) return path && insideRoot(path, root) ? 'local_write' : 'unsure'
  // Tools by name: payments, then sending; anything else is unknown.
  if (MONEY_NAME.test(tool)) return 'money'
  if (SQL_TOOL.test(tool) && /\b(?:DROP|TRUNCATE)\b/i.test(JSON.stringify(input) ?? '')) return 'irreversible'
  if (OUTWARD_NAME.test(tool)) return 'outward'
  return 'unsure'
}
