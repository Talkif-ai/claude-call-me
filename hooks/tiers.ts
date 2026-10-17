// The tier of one tool call a peer task wants to run, and the approval channels it
// allows, by the shared permission table (test-vectors/tiers.json v2, copied byte for
// byte from talkif-agents and mirrored into shared-tables.ts). The same table and the
// same algorithm run in every client and in the hub, which reclassifies each approval
// and keeps the stricter result. The algorithm text is the table's `algorithm`; this
// file is its implementation, and every `cases` row is a test.
//
// One thing the table cannot see is where an earlier Bash call left the shell (the
// Bash tool keeps its folder between calls). `shellCwdsAfter` tracks that set and
// `classify` starts the table's folder walk from it, as the spec's "shell's folder"
// rule asks; that is only ever stricter than the table alone, which starts at the root.

import { TIERS_JSON } from './shared-tables'
import { canonicalJson } from './tap1'

export const TIERS = ['read', 'local_write', 'outward', 'irreversible', 'unsure', 'secret', 'money', 'prod_deploy'] as const
export type Tier = (typeof TIERS)[number]

export type Channels = { terminalApprove: boolean; voiceApprove: boolean; needsOwnerProof: boolean }

type RuleOn = 'tool' | 'command' | 'segment' | 'rawSegment' | 'path' | 'input' | 'outside' | 'redirect' | 'searchRoot' | 'assignment'
type Rule = { id: string; tier: Tier; on: RuleOn; pattern: string; target?: string; unless?: string; tools?: string; ci?: boolean }

type TierTable = {
  v: number
  rank: Record<Tier, number>
  channels: Record<Tier, Channels>
  readTools: string[]
  writeTools: string[]
  pathFields: string[]
  prefixWords: string[]
  prefixPairs: string[]
  shells: string[]
  readers: { commands: string[]; git: string[]; gh: string[] }
  rules: Rule[]
}

type Compiled = Rule & { re: RegExp; unlessRe?: RegExp; toolsRe?: RegExp; targetRe?: RegExp }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
export const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v)

let cachedTable: TierTable | undefined
const table = (): TierTable => {
  if (cachedTable) return cachedTable
  // The generated mirror of tiers.json; its shape is the file's, checked by the vector tests.
  const parsed = JSON.parse(TIERS_JSON) as TierTable
  if (parsed.v !== 2) throw new Error(`tiers.json v${String(parsed.v)} is not the version this plugin implements (2)`)
  cachedTable = parsed
  return parsed
}

let compiledRules: Compiled[] | undefined
const rules = (): Compiled[] => {
  compiledRules ??= table().rules.map(r => {
    const flags = r.ci ? 'i' : ''
    return {
      ...r,
      re: new RegExp(r.pattern, flags),
      ...(r.unless ? { unlessRe: new RegExp(r.unless, flags) } : {}),
      ...(r.tools ? { toolsRe: new RegExp(r.tools, flags) } : {}),
      ...(r.target ? { targetRe: new RegExp(r.target, flags) } : {}),
    }
  })
  return compiledRules
}

export const rank = (t: Tier): number => table().rank[t]
export const stricter = (a: Tier, b: Tier): Tier => (rank(a) >= rank(b) ? a : b)
export const channelsOf = (t: Tier): Channels => table().channels[t]

/** Channels over every tier that applied (read left out unless it is the only one). */
export const mergeChannels = (tiers: readonly Tier[]): Channels => {
  const set = [...new Set(tiers)]
  const counted = set.length > 1 ? set.filter(t => t !== 'read') : set
  const ch = counted.map(channelsOf)
  return {
    terminalApprove: ch.every(c => c.terminalApprove),
    voiceApprove: ch.every(c => c.voiceApprove),
    needsOwnerProof: ch.some(c => c.needsOwnerProof),
  }
}

// ---- the table's text functions ----

const QUIET = /(\s)2>(&1|\/dev\/null)(\s|$)/g
const quiet = (command: string): string => {
  let out = command
  for (;;) {
    const next = out.replace(QUIET, '$1$3')
    if (next === out) return out
    out = next
  }
}

const splitSegments = (command: string): string[] =>
  command
    .split(/&&|\|\||[;|&()`{}\n]/)
    .map(s => s.trim())
    .filter(Boolean)

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/
const SHELL_C = /^-[A-Za-z]*c$/
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir'])
const MAX_LISTS = 64

const shellWords = (s: string): string[] =>
  s
    .split(/\s+/)
    .map(w => w.replace(/["'\\]/g, ''))
    .filter(Boolean)

const basename = (w: string): string => {
  const b = w.slice(w.lastIndexOf('/') + 1)
  return b === '' ? w : b
}

const dropAssignments = (words: string[]): string[] => {
  let i = 0
  while (i < words.length && ASSIGN.test(words[i] ?? '')) i++
  return words.slice(i)
}

/** Every command a raw segment may run: itself, and what its wrappers, shells and finds run. */
const candidates = (raw: string, t: TierTable): string[] => {
  const out = new Set<string>()
  const queue: string[][] = [shellWords(raw)]
  const seen = new Set<string>([queue[0]?.join(' ') ?? ''])
  for (let taken = 0; queue.length > 0 && taken < MAX_LISTS; taken++) {
    const list = dropAssignments(queue.shift() ?? [])
    if (list.length === 0) continue
    const L = [basename(list[0] ?? ''), ...list.slice(1)]
    out.add(L.join(' '))
    const cuts: number[] = []
    const first = L[0] ?? ''
    if (t.prefixWords.includes(first)) cuts.push(1)
    if (L.length > 1 && t.prefixPairs.includes(`${first} ${L[1] ?? ''}`)) cuts.push(2)
    for (let i = 1; i < L.length; i++) {
      if (t.shells.includes(first) && SHELL_C.test(L[i] ?? '')) cuts.push(i + 1)
      if (first === 'find' && FIND_EXEC.has(L[i] ?? '')) cuts.push(i + 1)
    }
    for (const s of cuts) {
      for (let k = s; k < L.length; k++) {
        const suffix = L.slice(k)
        const key = suffix.join(' ')
        if (seen.has(key)) continue
        seen.add(key)
        queue.push(suffix)
      }
    }
  }
  return [...out]
}

/** The command a raw segment runs once its wrappers (sudo, env, npx …) are taken off. */
const primary = (raw: string, t: TierTable): string => {
  let words = dropAssignments(shellWords(raw))
  for (;;) {
    const first = words[0] ?? ''
    let n = 0
    if (words.length > 2 && t.prefixPairs.includes(`${first} ${words[1] ?? ''}`)) n = 2
    else if (words.length > 1 && t.prefixWords.includes(first)) n = 1
    if (n === 0) break
    words = words.slice(n)
    while (words.length > 0 && ((words[0] ?? '').startsWith('-') || ASSIGN.test(words[0] ?? ''))) words = words.slice(1)
  }
  if (words.length === 0) return ''
  return [basename(words[0] ?? ''), ...words.slice(1)].join(' ')
}

const redirectTargets = (raw: string): string[] => {
  const out: string[] = []
  for (const m of raw.matchAll(/>[>|]?\s*([^\s<>]+)/g)) out.push((m[1] ?? '').replace(/["'\\]/g, ''))
  return out.filter(Boolean)
}

const normalizePath = (path: string): string => {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

/** Every folder the Bash tool's shell may be in: absolute paths, undefined for one not known. */
export type Cwds = readonly (string | undefined)[]

const underRoot = (a: string, cwd: string): boolean => {
  const root = normalizePath(cwd)
  return a === root || a.startsWith(root === '/' ? '/' : `${root}/`)
}

const resolveFrom = (f: string, p: string): string => {
  if (p.startsWith('~')) return p.replace(/\/+$/, '') || '~'
  return normalizePath(p.startsWith('/') ? p : `${f}/${p}`)
}

const insideFrom = (p: string, cwd: string, folders: Cwds): boolean => {
  if (p.startsWith('~') || p.includes('$')) return false
  if (p.startsWith('/')) return underRoot(normalizePath(p), cwd)
  return folders.every(f => f !== undefined && underRoot(resolveFrom(f, p), cwd))
}

const CD = new Set(['cd', 'pushd', 'chdir', 'popd'])

/** The folder set after a raw segment whose primary is `prim` (the table's `folders`). */
const foldersAfter = (prim: string, folders: Cwds, cwd: string): Cwds => {
  const words = prim.split(' ').filter(Boolean)
  const first = words[0] ?? ''
  if (!CD.has(first)) return folders
  const target = words.slice(1).find(w => !w.startsWith('-') || w === '-')
  const add: (string | undefined)[] =
    first === 'popd' || target === undefined || target === '-' || target.startsWith('~') || target.includes('$')
      ? [undefined]
      : folders.map(f => {
          if (f === undefined) return undefined
          const a = resolveFrom(f, target)
          return underRoot(a, cwd) ? a : undefined
        })
  return [...new Set([...folders, ...add])]
}

const leadingAssignments = (raw: string, t: TierTable): string[] => {
  const words = shellWords(raw)
  const out: string[] = []
  let afterPrefix = false
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? ''
    if (ASSIGN.test(w)) out.push(w)
    else if (afterPrefix && w.startsWith('-')) continue
    else if (i + 1 < words.length && t.prefixPairs.includes(`${w} ${words[i + 1] ?? ''}`)) {
      afterPrefix = true
      i++
    } else if (t.prefixWords.includes(w)) afterPrefix = true
    else break
  }
  return out
}

const isReader = (segment: string, readers: TierTable['readers']): boolean => {
  const w = segment.split(' ').filter(Boolean)
  if (w.some(x => x.startsWith('--output') || x.startsWith('--pre'))) return false
  const [cmd, sub, third] = w
  if (cmd === undefined) return false
  if (readers.commands.includes(cmd)) return true
  if (cmd === 'git') return sub !== undefined && readers.git.includes(sub)
  if (cmd === 'gh') return sub !== undefined && /^[a-z-]+$/.test(sub) && third !== undefined && readers.gh.includes(third)
  return false
}

// ---- the shell's folder across Bash calls ----

const MAX_CWDS = 8
const capped = (cwds: Cwds): (string | undefined)[] => (cwds.length > MAX_CWDS ? [undefined] : [...cwds])

/**
 * The folder set a call starts from: `cd <absolute path inside the root> &&` at the
 * very start makes it known again (whatever ran before), else what earlier calls left.
 */
const startFolders = (command: string, cwds: Cwds, root: string): Cwds => {
  const m = /^\s*cd\s+(\/\S+)\s*&&/.exec(quiet(command))
  const target = m?.[1]?.replace(/["'\\]/g, '')
  return target !== undefined && !target.includes('$') && underRoot(normalizePath(target), root) ? [root] : cwds
}

/** Where the shell may be after `command` ran, given where it may have been. */
export function shellCwdsAfter(command: string, cwds: Cwds, root: string): (string | undefined)[] {
  const t = table()
  let folders = startFolders(command, cwds, root)
  for (const raw of splitSegments(quiet(command))) folders = foldersAfter(primary(raw, t), folders, root)
  // F only grows: the command may stop before a cd, or the cd may fail.
  return capped([...new Set([...cwds, ...folders])])
}

// ---- classification ----

export type Classification = { tier: Tier; channels: Channels; matched: string[] }

/**
 * The tier and channels of one tool call. `root` is the session's folder (the table's
 * `cwd`); `cwds` is where the shell may be, the root when omitted (exactly the table).
 */
export function classifyAction(tool: string, inputValue: unknown, root: string, cwds: Cwds = [root]): Classification {
  const t = table()
  const input = isRecord(inputValue) ? inputValue : {}
  const isBash = tool === 'Bash'
  const rawCommand = isBash && typeof input.command === 'string' ? input.command : undefined
  const command = rawCommand !== undefined ? quiet(rawCommand) : undefined
  const rawSegments = command !== undefined ? splitSegments(command) : []
  const primaries = rawSegments.map(s => primary(s, t))
  const start = rawCommand !== undefined ? startFolders(rawCommand, cwds, root) : [root]
  const judged: { segments: string[]; targets: string[]; folders: Cwds }[] = []
  let folders: Cwds = start
  rawSegments.forEach((raw, i) => {
    const prim = primaries[i] ?? ''
    judged.push({ segments: [...new Set([...candidates(raw, t), ...(prim ? [prim] : [])])], targets: redirectTargets(raw), folders })
    folders = foldersAfter(prim, folders, root)
  })
  const segments = [...new Set(judged.flatMap(j => j.segments))]
  const assignments = rawSegments.flatMap(raw => leadingAssignments(raw, t))

  const pathCandidates: string[] = isBash
    ? segments.flatMap(s => s.split(' ').flatMap(w => [w, ...w.split(/[=:]/)]))
    : t.pathFields.map(f => input[f]).filter((v): v is string => typeof v === 'string')

  const matched: Compiled[] = []
  let toolRuleMatched = false
  const test = (r: Compiled, text: string): boolean => r.re.test(text) && !(r.unlessRe?.test(text) ?? false)
  const outsideWord = (w: string, f: Cwds): boolean => [w, ...w.split('=')].some(part => part !== '' && !part.startsWith('-') && !insideFrom(part, root, f))
  const reachesTarget = (r: Compiled, roots: readonly string[], f: Cwds): boolean =>
    roots.some(
      r0 =>
        r0.includes('$') ||
        f.some(base => {
          if (base === undefined && !r0.startsWith('/') && !r0.startsWith('~')) return true
          return r.targetRe?.test(resolveFrom(base ?? root, r0)) ?? false
        }),
    )
  for (const r of rules()) {
    let hit = false
    switch (r.on) {
      case 'tool':
        hit = test(r, tool)
        if (hit) toolRuleMatched = true
        break
      case 'input':
        hit = (r.toolsRe?.test(tool) ?? true) && test(r, canonicalJson(input))
        if (hit) toolRuleMatched = true
        break
      case 'command':
        hit = command !== undefined && test(r, command.replace(/&&|\|\|/g, ''))
        break
      case 'segment':
        hit = segments.some(s => test(r, s))
        break
      case 'rawSegment':
        hit = rawSegments.some(s => test(r, s))
        break
      case 'path':
        hit = (r.toolsRe?.test(tool) ?? true) && pathCandidates.some(p => test(r, p))
        break
      case 'outside':
        hit = isBash && judged.some(j => j.segments.some(s => test(r, s) && s.split(' ').slice(1).some(w => outsideWord(w, j.folders))))
        break
      case 'redirect':
        hit = isBash && judged.some(j => j.targets.some(x => !x.startsWith('&') && test(r, x) && !insideFrom(x, root, j.folders)))
        break
      case 'searchRoot':
        if (isBash) {
          hit = judged.some(j => j.segments.some(s => test(r, s) && reachesTarget(r, ['.', ...s.split(' ').slice(1).filter(w => w !== '' && !w.startsWith('-'))], j.folders)))
        } else if (r.toolsRe?.test(tool) ?? false) {
          const roots = ['.', ...t.pathFields.map(f => input[f]).filter((v): v is string => typeof v === 'string')]
          hit = reachesTarget(r, roots, [root])
        }
        break
      case 'assignment':
        hit = isBash && assignments.some(a => test(r, a))
        break
    }
    if (hit) matched.push(r)
  }

  let base: Tier
  if (t.readTools.includes(tool)) base = 'read'
  else if (t.writeTools.includes(tool)) base = pathCandidates.length > 0 && pathCandidates.every(p => insideFrom(p, root, [root])) ? 'local_write' : 'unsure'
  else if (isBash) {
    if (command === undefined || command.trim() === '') base = 'unsure'
    else base = primaries.every(s => isReader(s, t.readers)) ? 'read' : 'local_write'
  } else base = toolRuleMatched ? 'read' : 'unsure'

  const tiers: Tier[] = [base, ...matched.map(r => r.tier)]
  // The shell may be somewhere not known (an earlier call left it there): what any
  // command does then is not known either, so nothing below `unsure` runs unasked.
  if (isBash && start.includes(undefined)) tiers.push('unsure')
  const tier = tiers.reduce((top, x) => (rank(x) > rank(top) ? x : top), base)
  return { tier, channels: mergeChannels(tiers), matched: matched.map(r => r.id) }
}

/** The tier of one tool call, by the shared table (see classifyAction). */
export const classify = (tool: string, input: unknown, root: string, cwds: Cwds = [root]): Tier => classifyAction(tool, input, root, cwds).tier
