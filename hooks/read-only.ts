// Read-only call tasks: while a task given on a phone call runs, only tools that
// read are let through. An allowlist, not a list of writers: a tool this file does
// not know (an MCP tool, a publish, a message, a schedule) is refused too. A Bash
// command passes only when every part of it is on a short list of read-only
// commands; anything the list does not know (env prefixes, redirects,
// substitutions, quoting) is refused.

// Tools that only read, or only touch the session's own task list.
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'LSP', 'NotebookRead', 'ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])

// Plain readers. `rg --pre` runs a program per file, so it is refused below.
const READERS = new Set(['ls', 'cat', 'head', 'tail', 'grep', 'rg', 'pwd', 'wc'])
const GIT_READ = new Set(['status', 'log', 'diff', 'show'])
const GH_READ = new Set(['view', 'list'])

// Harmless stderr redirects are dropped before the check; every other redirect,
// substitution, background job or subshell refuses the whole command.
const QUIET = /\s2>(?:&1|\/dev\/null)(?=\s|$)/g
const UNSAFE = /[<>`&()$\n\r\\]/

const segmentIsReadOnly = (segment: string): boolean => {
  if (UNSAFE.test(segment)) return false
  const words = segment.trim().split(/\s+/).filter(Boolean)
  const [cmd, sub, third] = words
  if (!cmd) return false
  if (words.some(w => w.startsWith('--output') || w.startsWith('--pre'))) return false
  if (READERS.has(cmd)) return true
  // `git -c …` / `git --git-dir …` before the subcommand can run a configured program.
  if (cmd === 'git') return sub !== undefined && GIT_READ.has(sub)
  // gh <noun> view|list (gh pr view 12, gh run list): never gh api or anything that writes.
  if (cmd === 'gh') return sub !== undefined && /^[a-z-]+$/.test(sub) && third !== undefined && GH_READ.has(third)
  return false
}

// Credential paths: never read during a call task, also by a reader. What a call
// task reads can be said on the call or land in its report; redaction is best
// effort, so these are not read at all. Matched on the path as written (the
// command's words, the tool's path argument): `~`, absolute and relative alike,
// `..` resolved, and shell globs and braces judged by what they could match.
// `secrets/` is a common name for a folder of local secret values.
const CREDENTIAL_DIR = /(?:^|\/)(?:\.ssh|\.aws|\.kube|\.docker|\.gnupg|secrets|\.config\/(?:gcloud|talkif|gh))(?:\/|$)/i
const CREDENTIAL_FILE = /^(?:\.env(?:\..*)?|.+\.env|\.netrc|\.git-credentials|\.npmrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519).*|credentials\.json|.+\.pem|.+\.key)$/i

// `a/b/../c` → `a/c`, `./` and `//` dropped; a leading `..` stays.
const normalizePath = (path: string): string => {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '.' || (part === '' && out.length > 0)) continue
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..' && out[out.length - 1] !== '') out.pop()
    else out.push(part)
  }
  return out.join('/').replace(/\/+$/, '')
}

// Under the home folder: Claude Code's own settings and plugin options (~/.claude,
// ~/.claude.json), which can hold keys. A project's own .claude folder is not this.
const HOME_AGENT_CONFIG = /^(?:~|\/(?:Users|home)\/[^/]+|\/root)\/(?:\.claude(?:\/|$)|\.claude\.json$)/

const isLiteralCredentialPath = (clean: string): boolean => {
  if (!clean) return false
  if (CREDENTIAL_DIR.test(clean) || HOME_AGENT_CONFIG.test(clean)) return true
  return CREDENTIAL_FILE.test(clean.split('/').pop() ?? '')
}

// Glob and brace words (`~/.ss?/id_*`, `~/.{ssh,aws}/x`, `.e{n,}v`, `*.p[e]m`): braces
// are expanded as the shell would, then each glob segment becomes a regex tried on
// credential names. A segment that also matches an ordinary name of the same shape
// (`*`, `*.json`) is generic and passes, as `grep -r` does; one that matches only
// credential names (`.*`, `id_*`, `*.p?m`) refuses the word.
const GLOB = /[*?[]/
const CREDENTIAL_NAMES = ['.ssh', '.aws', '.kube', '.docker', '.gnupg', 'secrets', '.env', '.env.local', 'prod.env', '.netrc', '.git-credentials', '.npmrc', '.pypirc', 'id_rsa', 'id_ed25519', 'credentials.json', 'server.pem', 'server.key']
const CONFIG_NAMES = ['gcloud', 'talkif', 'gh']
const ORDINARY_NAMES = ['zq9', ...['json', 'ts', 'tsx', 'js', 'mjs', 'md', 'yaml', 'yml', 'txt', 'rs', 'py', 'toml', 'log', 'sql', 'sh', 'lock', 'html', 'css'].map(ext => `zq9.${ext}`)]
const MAX_EXPANSIONS = 64

// `{a,b}` and `{a..c}` / `{1..3}` as the shell expands them; an unbalanced or
// comma-less brace stays literal (as in bash). Undefined: too many words (refused).
const expandBraces = (word: string): string[] | undefined => {
  const out: string[] = []
  const queue = [word]
  while (queue.length > 0) {
    const w = queue.shift() ?? ''
    const alternatives = firstBrace(w)
    if (alternatives === 'too-many') return undefined
    if (!alternatives) {
      out.push(w)
    } else {
      queue.push(...alternatives)
    }
    if (out.length + queue.length > MAX_EXPANSIONS) return undefined
  }
  return out
}

// The words the first expandable brace of `w` makes, or undefined when it has none.
const firstBrace = (w: string): string[] | 'too-many' | undefined => {
  for (let open = w.indexOf('{'); open >= 0; open = w.indexOf('{', open + 1)) {
    let depth = 0
    const commas: number[] = []
    for (let i = open; i < w.length; i++) {
      const c = w.charAt(i)
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) {
          const head = w.slice(0, open)
          const tail = w.slice(i + 1)
          const body = w.slice(open + 1, i)
          if (commas.length > 0) {
            const parts: string[] = []
            let from = open + 1
            for (const at of commas) {
              parts.push(w.slice(from, at))
              from = at + 1
            }
            parts.push(w.slice(from, i))
            return parts.map(p => head + p + tail)
          }
          const range = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])$/.exec(body)
          if (range?.[1] !== undefined && range[2] !== undefined) {
            const items = rangeOf(range[1], range[2])
            return items ? items.map(p => head + p + tail) : 'too-many'
          }
          break
        }
      } else if (c === ',' && depth === 1) commas.push(i)
    }
  }
  return undefined
}

// Undefined: too many items (refused). A mixed range (`{1..a}`) stays literal.
const rangeOf = (from: string, to: string): string[] | undefined => {
  const isInt = (v: string): boolean => /^-?\d+$/.test(v)
  if (isInt(from) !== isInt(to)) return [`{${from}..${to}}`]
  const numeric = isInt(from)
  const a = numeric ? Number.parseInt(from, 10) : from.charCodeAt(0)
  const b = numeric ? Number.parseInt(to, 10) : to.charCodeAt(0)
  if (Math.abs(a - b) >= MAX_EXPANSIONS) return undefined
  const step = a <= b ? 1 : -1
  const out: string[] = []
  for (let n = a; n !== b + step; n += step) out.push(numeric ? String(n) : String.fromCharCode(n))
  return out
}

const escapeRe = (c: string): string => c.replace(/[.+^$()|{}[\]\\/]/g, '\\$&')

// One path segment's glob as a regex; an unclosed `[` is literal, as in the shell.
const segmentRegex = (glob: string): RegExp | undefined => {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i)
    const close = c === '[' ? glob.indexOf(']', i + 2) : -1
    if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else if (close > 0) {
      re += `[${glob.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`
      i = close
    } else re += escapeRe(c)
  }
  // As the shell does: a wildcard first does not match a leading dot.
  const lead = /^[*?[]/.test(glob) ? '(?!\\.)' : ''
  try {
    return new RegExp(`^${lead}(?:${re})$`, 'i')
  } catch {
    return undefined
  }
}

// Whether a path segment (a glob or a plain name) can be `name`.
const segmentCanBe = (segment: string, name: string): boolean =>
  GLOB.test(segment) ? (segmentRegex(segment)?.test(name) ?? true) : segment.toLowerCase() === name

const globNamesCredential = (path: string): boolean => {
  const segments = path.split('/')
  return segments.some((segment, i) => {
    const previous = segments[i - 1]
    const globHere = GLOB.test(segment)
    // `.config/<name>` where either part is a glob (`~/.c*/talkif`, `~/.config/g*`,
    // `~/.config/*`): no generic pass here, `.config` holds the credential folders.
    if ((globHere || (previous !== undefined && GLOB.test(previous))) && previous !== undefined && segmentCanBe(previous, '.config')) {
      if (CONFIG_NAMES.some(n => segmentCanBe(segment, n))) return true
    }
    if (!globHere) return false
    const re = segmentRegex(segment)
    if (!re) return true
    if (ORDINARY_NAMES.some(n => re.test(n))) return false
    return CREDENTIAL_NAMES.some(n => re.test(n))
  })
}

export const isCredentialPath = (path: string): boolean => {
  const words = expandBraces(path.replace(/["']/g, ''))
  if (!words) return true
  return words.some(word => {
    const clean = normalizePath(word)
    return isLiteralCredentialPath(clean) || (GLOB.test(clean) && globNamesCredential(clean))
  })
}

// A command names a credential path when any word, or a part of one after `=` or `:`
// (`--file=~/.aws/credentials`, `git show HEAD:.env`), is one.
export const namesCredentialPath = (command: string): boolean =>
  command
    .split(/[\s|;&]+/)
    .flatMap(word => [word, ...word.split(/[=:]/)])
    .some(isCredentialPath)

// ---- recursive reads of a folder that holds credential folders ----
// `grep -r "" ~/.config` names no credential path, yet reads ~/.config/talkif,
// ~/.ssh and the rest. A recursive reader whose root is the home folder, its
// .config, a user folder, /Users, /home or / is refused like a credential path.

const ANCESTOR = /^(?:\/System\/Volumes\/Data)?(?:\/|\/(?:Users|home)(?:\/[^/]+(?:\/\.config)?)?|\/root(?:\/\.config)?|\/var\/root(?:\/\.config)?)$|^~[^/]*(?:\/\.config)?$/

/** Whether a folder (absolute, or `~…`) holds credential folders below it. */
export const isCredentialAncestor = (path: string): boolean => {
  const p = path.replace(/["']/g, '').replace(/\/+$/, '')
  return ANCESTOR.test(p === '' ? '/' : p)
}

/**
 * `path` as an absolute, normalized path when it runs in `base`; `~…` stays as
 * written (the home folder is not known here). Undefined when it cannot be known:
 * no base for a relative path, or a `$`/backquote in it.
 */
export function resolvePath(base: string | undefined, path: string): string | undefined {
  const p = path.replace(/["']/g, '')
  if (/[$`]/.test(p)) return undefined
  if (p.startsWith('~')) return p.replace(/\/+$/, '') || '~'
  const abs = p.startsWith('/') ? p : base === undefined ? undefined : `${base}/${p}`
  if (abs === undefined) return undefined
  const parts: string[] = []
  for (const part of abs.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

const GREPS = new Set(['grep', 'egrep', 'fgrep', 'ggrep', 'zgrep'])
const ALWAYS_RECURSIVE = new Set(['rg', 'ag', 'ack', 'ugrep', 'find', 'tree', 'du'])
const PATTERN_FLAGS = /^(?:-[a-zA-Z]*[ef]|--regexp(?:=.*)?|--file(?:=.*)?)$/

/** The folders a recursive reader in `words` searches (`.` when none is named), or undefined when it is not one. */
export function recursiveTargets(words: readonly string[]): string[] | undefined {
  let i = 0
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? '')) i++
  const prog = (words[i] ?? '').split('/').pop() ?? ''
  const args = words.slice(i + 1)
  const grep = GREPS.has(prog)
  const recursive =
    ALWAYS_RECURSIVE.has(prog) ||
    (grep && args.some(a => /^-[^-]*[rR]/.test(a) || /^--(?:dereference-)?recursive$/.test(a) || a === '--directories=recurse' || a === 'recurse'))
  if (!recursive) return undefined
  const plain = args.filter(a => !a.startsWith('-') && a !== 'recurse')
  // The first plain word of a search is its pattern, unless -e/-f gave the pattern.
  const searches = grep || ['rg', 'ag', 'ack', 'ugrep'].includes(prog)
  const paths = searches && !args.some(a => PATTERN_FLAGS.test(a)) ? plain.slice(1) : plain
  return paths.length > 0 ? paths : ['.']
}

/**
 * Whether one of `targets`, run in every one of `cwds` (undefined: a folder not
 * known), is a folder that holds credential folders. Unknown counts as one.
 */
export function targetsCredentialAncestor(targets: readonly string[], cwds: readonly (string | undefined)[]): boolean {
  return targets.some(t =>
    cwds.some(base => {
      const abs = resolvePath(base, t)
      return abs === undefined || isCredentialAncestor(abs)
    }),
  )
}

/** Whether any command of `command` has an argument that is not an option or an absolute path. */
const relativeWords = (command: string): boolean =>
  command
    .replace(QUIET, ' ')
    .split(/\|\||&&|[|;&\n]/)
    .some(segment => segment.trim().split(/\s+/).slice(1).some(w => w !== '' && !w.startsWith('-') && !w.replace(/["']/g, '').startsWith('/')))

/** A Bash command with a recursive reader over such a folder. */
export const readsCredentialAncestor = (command: string, cwds: readonly (string | undefined)[]): boolean =>
  command
    .replace(QUIET, ' ')
    .split(/\|\||&&|[|;&\n]/)
    .some(segment => {
      const targets = recursiveTargets(segment.trim().split(/\s+/).filter(Boolean))
      return targets !== undefined && targetsCredentialAncestor(targets, cwds)
    })

export const isReadOnlyCommand = (command: string): boolean => {
  const line = command.replace(QUIET, ' ').trim()
  if (!line) return false
  return line.split(/\|\||&&|[|;]/).every(segmentIsReadOnly)
}

/**
 * One tool call as the guard judges it. `background`: the call keeps running after
 * the task's turn ends, out of the guard's sight. `remote`: it runs where no hook of
 * this session sees its tools.
 */
export type GuardedCall = {
  tool: string
  command?: string
  paths?: readonly string[]
  background?: boolean
  remote?: boolean
  /** Where the shell may be (undefined: not known). Peer tasks only; without it the folder counts as not known. */
  cwds?: readonly (string | undefined)[]
}

const readsCredential = (call: GuardedCall): boolean =>
  (call.paths ?? []).some(isCredentialPath) || (call.tool === 'Bash' && namesCredentialPath(call.command ?? ''))

// Peer tasks also refuse a recursive read whose root holds credential folders
// (the Grep and Glob tools, grep -r, rg, find …). Call tasks keep their rules.
const readsCredentialTree = (call: GuardedCall): boolean => {
  const cwds = call.cwds ?? [undefined]
  if (call.tool === 'Grep' || call.tool === 'Glob') return targetsCredentialAncestor(call.paths?.length ? call.paths : ['.'], cwds)
  return call.tool === 'Bash' && readsCredentialAncestor(call.command ?? '', cwds)
}

const readsOnly = (call: GuardedCall): boolean => {
  if (call.background || call.remote) return false
  if (call.tool === 'Bash') return isReadOnlyCommand(call.command ?? '')
  // A subagent's own tool calls are held to this same list (see agent.spawn in register.tsx).
  if (call.tool === 'Agent') return true
  return READ_TOOLS.has(call.tool)
}

/** The deny text for a tool call, or undefined when the call only reads. `from`: who gave the task. */
export const readOnlyDenial = (call: GuardedCall, from: 'call' | 'peer' = 'call'): string | undefined => {
  if (from === 'peer') {
    if (readsCredential(call) || readsCredentialTree(call)) {
      return (
        `${call.tool} was not run: this task came from another connected agent, and credential files (~/.ssh, ~/.aws, ~/.config/gcloud, ~/.config/talkif, ~/.claude, .env files, keys, .netrc, credentials.json) are never read during one, nor searched through a folder that holds them (the home folder, ~/.config, /). ` +
        'Do not try another way to read it. Search inside the project folder instead, or say which file you would check and why.'
      )
    }
    if (readsOnly(call) && call.tool === 'Bash' && call.cwds?.includes(undefined) && relativeWords(call.command ?? '')) {
      return (
        `${call.tool} was not run: the shell of this session may be in another folder than the project (an earlier cd), so a relative path may name another file. ` +
        'Run it again with absolute paths inside the project folder.'
      )
    }
    if (readsOnly(call)) return undefined
    return (
      `${call.tool} was not run: this task came from another connected agent and runs read-only on this machine (call-me option peerTasks, or the agent's mode in Talkif). ` +
      'Only reading tools work, in the foreground. Do not try another way to make the change. Finish with what you found and say exactly what you would change.'
    )
  }
  if (readsCredential(call)) {
    return (
      `${call.tool} was not run: this task came from a phone call, and credential files (~/.ssh, ~/.aws, ~/.config/gcloud, ~/.config/talkif, ~/.claude, .env files, keys, .netrc, credentials.json) are never read during one. ` +
      'Do not try another way to read it. Say which file you would check and why, so the developer can look in the terminal.'
    )
  }
  if (readsOnly(call)) return undefined
  return (
    `${call.tool} was not run: this task came from a phone call and runs read-only (call-me option callTasks: read-only). ` +
    'Only reading tools work, in the foreground. Do not try another way to make the change. Finish the task with what you found ' +
    'and say exactly what you would change, so the developer can approve it in the terminal.'
  )
}

/**
 * Which loops a call task covers. The session's own turn while a call task runs,
 * and the subagents that turn (or one of its subagents) starts: those stay covered
 * after the turn ends, as a background one outlives it. A subagent started before
 * the call task, by the developer, or by another agent outside it is never covered,
 * even while a call task runs in the same session.
 */
export class CallTaskScope {
  private turn: string | undefined
  // Started by a call task: covered for good.
  private readonly covered = new Set<string>()
  // Started outside a call task: never covered.
  private readonly free = new Set<string>()
  // Spawns a call task asked for that have not answered their id yet. An agent
  // this scope has never seen is held to the guard meanwhile, so a subagent's
  // first tool call can never run before its id is known.
  private spawning = 0

  /** The call task's turn of the session, if one runs. */
  get turnId(): string | undefined {
    return this.turn
  }

  startTurn(turnId: string): void {
    this.turn = turnId
  }

  /** The turn ended (turnId) or a typed prompt replaced it (no id). */
  endTurn(turnId?: string): void {
    if (turnId === undefined || this.turn === turnId) this.turn = undefined
  }

  /** Whether a tool call or spawn in this loop (undefined: the session's own) is covered. */
  covers(agentId: string | undefined): boolean {
    if (agentId === undefined) return this.turn !== undefined
    if (this.covered.has(agentId)) return true
    if (this.free.has(agentId)) return false
    return this.spawning > 0
  }

  /** A spawn in `parentAgentId` begins; answers whether it is covered (pass it to spawnSettled). */
  spawnStarted(parentAgentId: string | undefined): boolean {
    const covered = this.covers(parentAgentId)
    if (covered) this.spawning++
    return covered
  }

  /** The spawn answered (agentId undefined: refused or failed). */
  spawnSettled(covered: boolean, agentId: string | undefined): void {
    if (covered) this.spawning = Math.max(0, this.spawning - 1)
    if (agentId === undefined) return
    if (covered) this.covered.add(agentId)
    else if (!this.covered.has(agentId)) this.free.add(agentId)
  }
}
