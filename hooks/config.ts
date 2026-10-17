// Setup: where the plugin's key, backend URL, flow and folders come from.
// Pure functions only, so they are tested without the engine.
//
// Users set the plugin options (apiKey in secure storage, apiUrl, flowId,
// folders). The developer path stays: with no apiKey, ~/.config/talkif/dev.env
// is read (TALKIF_API_KEY, TALKIF_API_URL, TALKIF_BRIDGE_KEY and
// TALKIF_<NAME>_BRIDGE_KEY for more accounts).

/** The Talkif API: the backend unless the apiUrl option names another. */
export const DEFAULT_API_URL = 'https://api.talkif.ai'

export const DEV_ENV_FILE = '.config/talkif/dev.env'
// Legacy dev file name, still read when dev.env is missing.
export const LEGACY_DEV_ENV_FILE = `.config/talkif/${'stag'}ing.env`
/** The developer files, in the order they are tried (paths under the home folder). */
export const DEV_ENV_FILES = [DEV_ENV_FILE, LEGACY_DEV_ENV_FILE] as const

/** One account the session joins the bridge in. */
export type BridgeKey = { name: string; key: string }

export type Credentials = {
  /** options: the plugin options; dev-file: the developer file (~/.config/talkif/dev.env). */
  source: 'options' | 'dev-file'
  /** The backend's base URL, no trailing slash. */
  url: string
  /** The key for calls and flows. */
  apiKey: string
  /** The keys the session joins the bridge with (the first is "personal" when present). */
  bridges: BridgeKey[]
}

/**
 * Something that keeps call-me from working, said plainly: what is wrong (no
 * capital, no full stop) and exactly one step that fixes it.
 */
export type Problem = { reason: string; next: string }

/** A problem as one sentence for a log line: "<reason>. Next: <step>". */
export const problemText = (p: Problem): string => `${p.reason}. Next: ${p.next}`

export type Resolved = { ok: true; credentials: Credentials } | { ok: false; problem: Problem }

/** The options this module reads, already narrowed from PluginOptions. */
export type SetupOptions = { apiKey: string; apiUrl: string }

const PASTE_KEY = 'paste it in /plugin → call-me → Configure options'

export const NO_KEY_PROBLEM: Problem = {
  reason: 'no Talkif API key is set',
  next: `create one in the Talkif dashboard (Developer → Credentials, scopes Connectors, Calls read and Flows read) and ${PASTE_KEY}`,
}

/**
 * The apiUrl option as a base URL (no trailing slash), DEFAULT_API_URL when empty,
 * or undefined when it is not an http(s) URL.
 */
export function normalizeApiUrl(raw: string): string | undefined {
  const url = raw.trim().replace(/\/+$/, '')
  if (!url) return DEFAULT_API_URL
  return /^https?:\/\/[^/\s]+/.test(url) ? url : undefined
}

export const badUrlProblem = (raw: string): Problem => ({
  reason: `the API URL option "${raw.trim()}" is not an http:// or https:// address`,
  next: `empty the API URL option in /plugin → call-me → Configure options to use Talkif (${DEFAULT_API_URL})`,
})

/** KEY=value lines; blank lines, comments and lines without "=" are skipped. */
export function parseEnvFile(text: string): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return vars
}

// TALKIF_BRIDGE_KEY → "personal"; TALKIF_<NAME>_BRIDGE_KEY → "<name>".
const BRIDGE_KEY_NAME = /^TALKIF_(?:([A-Z0-9]+)_)?BRIDGE_KEY$/

/**
 * The key from the options wins and also serves the bridge. Without one, the
 * developer file (when there is one; `devFileName` names it in messages).
 * The backend: the apiUrl option, else (dev file only) its TALKIF_API_URL, else
 * DEFAULT_API_URL.
 */
export function resolveCredentials(options: SetupOptions, devFile: string | undefined, devFileName = `~/${DEV_ENV_FILE}`): Resolved {
  const optionUrl = normalizeApiUrl(options.apiUrl)
  if (optionUrl === undefined) return { ok: false, problem: badUrlProblem(options.apiUrl) }
  const fromOption = options.apiUrl.trim() !== ''
  const key = options.apiKey.trim()
  if (key) {
    return { ok: true, credentials: { source: 'options', url: optionUrl, apiKey: key, bridges: [{ name: 'personal', key }] } }
  }
  if (devFile === undefined) return { ok: false, problem: NO_KEY_PROBLEM }
  const vars = parseEnvFile(devFile)
  const apiKey = vars.TALKIF_API_KEY ?? ''
  if (!apiKey) return { ok: false, problem: { reason: `${devFileName} has no TALKIF_API_KEY`, next: `add it there, or ${PASTE_KEY}` } }
  let url = optionUrl
  if (!fromOption && vars.TALKIF_API_URL) {
    const fileUrl = normalizeApiUrl(vars.TALKIF_API_URL)
    if (fileUrl === undefined) {
      return { ok: false, problem: { reason: `TALKIF_API_URL in ${devFileName} is not an http:// or https:// address`, next: 'fix it or remove the line' } }
    }
    url = fileUrl
  }
  const bridges: BridgeKey[] = []
  for (const [name, value] of Object.entries(vars)) {
    const m = BRIDGE_KEY_NAME.exec(name)
    if (!m || !value) continue
    bridges.push({ name: (m[1] ?? 'personal').toLowerCase(), key: value })
  }
  // The personal account first: rings go through it.
  bridges.sort((a, b) => Number(b.name === 'personal') - Number(a.name === 'personal'))
  return { ok: true, credentials: { source: 'dev-file', url, apiKey, bridges } }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Whether a flow definition has a Connectors node (a function of type "connectors") on any agent. */
export function hasConnectorsNode(definition: unknown): boolean {
  if (!isRecord(definition) || !isRecord(definition.nodes)) return false
  return Object.values(definition.nodes).some(
    node => isRecord(node) && Array.isArray(node.functions) && node.functions.some(fn => isRecord(fn) && fn.type === 'connectors'),
  )
}

export type FlowRef = { id: string; name: string }

/** The published flows from GET /flows/published ({ flows: [...] }), in the backend's order. */
export function publishedFlows(body: unknown): FlowRef[] {
  if (!isRecord(body) || !Array.isArray(body.flows)) return []
  return body.flows.flatMap(f =>
    isRecord(f) && typeof f.id === 'string' ? [{ id: f.id, name: typeof f.name === 'string' && f.name ? f.name : f.id }] : [],
  )
}

/**
 * The first flow whose definition has a Connectors node. `definitionOf` reads one
 * flow's definition (GET /flows/{id}); flows are tried in order, at most `limit`.
 */
export async function pickConnectorsFlow(
  flows: readonly FlowRef[],
  definitionOf: (id: string) => Promise<unknown>,
  limit = 25,
): Promise<FlowRef | undefined> {
  for (const flow of flows.slice(0, limit)) {
    if (hasConnectorsNode(await definitionOf(flow.id))) return flow
  }
  return undefined
}

export const NO_FLOW_PROBLEM: Problem = {
  reason: 'your Talkif account has no published flow with a Connectors node',
  next: 'in the Talkif flow builder add a Connectors node to an agent and publish the flow',
}

/** The folders option: comma- or newline-separated; `~/x` is under home, a relative path too. */
export function parseFolders(text: string, home: string): string[] {
  return text
    .split(/[,\n]/)
    .map(f => f.trim())
    .filter(Boolean)
    .map(f => (f === '~' ? home : f.startsWith('~/') ? `${home}/${f.slice(2)}` : f.startsWith('/') ? f : `${home}/${f}`))
    .map(f => f.replace(/\/+$/, '') || '/')
}

/** No folders: every session may join. Otherwise the session's directory must be one of them or under one. */
export function folderAllowed(cwd: string, folders: readonly string[]): boolean {
  if (folders.length === 0) return true
  const dir = cwd.replace(/\/+$/, '') || '/'
  return folders.some(f => f === '/' || dir === f || dir.startsWith(`${f}/`))
}

/** A 401/403 from the backend, said so the user knows what to do; undefined for any other status. */
export function refusalReason(status: number, text: string): Problem | undefined {
  if (status !== 401 && status !== 403) return undefined
  if (text.includes('connectors_consent_required')) {
    return { reason: 'Connectors are not turned on for your Talkif account', next: 'an owner or admin turns them on in the Talkif dashboard (Developer → Integrations)' }
  }
  if (text.includes('api_key_insufficient_scope')) {
    return { reason: 'the API key lacks a scope it needs', next: 'add the scopes Connectors, Calls (read) and Flows (read) to the key in Developer → Credentials' }
  }
  if (text.includes('api_key_ip_restricted')) {
    return { reason: "this computer's IP address is not on the API key's allowlist", next: 'add it to the key in Developer → Credentials, or remove the restriction' }
  }
  if (status === 401) return { reason: 'the API key was refused (expired or revoked?)', next: `create a new key in Developer → Credentials and ${PASTE_KEY}` }
  return { reason: 'the API key is not allowed to do this', next: 'run /cm setup to see what is missing' }
}

const AGENT_SETTINGS = 'the Talkif dashboard (Settings → Personal Agent)'
const AGENT_REFUSALS: ReadonlyArray<readonly [string, Problem]> = [
  ['not_enabled', { reason: 'Personal Agent is not turned on for your Talkif account', next: 'ask Talkif to turn it on for you' }],
  ['paused', { reason: 'your connected agents are paused', next: `resume them in ${AGENT_SETTINGS}` }],
  ['credential_revoked', { reason: 'the Personal Agent credential was revoked', next: `create a new one in ${AGENT_SETTINGS} and paste it in /plugin → call-me → Configure options` }],
  ['key_already_set', { reason: 'this connected agent already has keys from another machine or install', next: `rotate its credential in ${AGENT_SETTINGS}, then paste the new one here` }],
  ['session_superseded', { reason: 'another session now holds this connected agent', next: 'nothing: this session stands by and takes over when the other one stops' }],
  ['owner_proof_required', { reason: 'this needs your approval with a passkey', next: `approve it in ${AGENT_SETTINGS} (add a passkey first if you have none)` }],
  ['sender_may_not_assign_writes', { reason: 'that agent may not give tasks that change files', next: `allow it in ${AGENT_SETTINGS} if you want it to` }],
]

/** A Personal Agent refusal in a hub answer (its `meta.refusal`), said plainly; undefined for any other answer. */
export function agentRefusalReason(text: string): Problem | undefined {
  const code = /"refusal"\s*:\s*"([a-z_]+)"/.exec(text)?.[1]
  return code === undefined ? undefined : AGENT_REFUSALS.find(([c]) => c === code)?.[1]
}

// ---- Personal Agent: the agent credential and where owner proofs come from ----

/** A person-bound agent credential: from the agentKey option, else TALKIF_AGENT_KEY in the developer file. */
export type AgentCredentials = {
  key: string
  url: string
  /** The passkey site an owner proof must come from; undefined: outward actions never run here. */
  owner: { rpId: string; origins: string[] } | undefined
}

export const AGENT_KEY_PREFIX = 'tif_agent_'

/** Where the person's passkey approvals come from on Talkif itself (the dashboard's site). */
export const TALKIF_OWNER_ORIGIN = { rpId: 'talkif.ai', origins: ['https://app.talkif.ai', 'https://talkif.ai'] } as const

/**
 * The agent credential, or undefined when none is set (Personal Agent is off and
 * nothing of it runs). Owner proofs come from Talkif's own site on the default
 * API; on another API URL only from TALKIF_AGENT_RP_ID / TALKIF_AGENT_ORIGINS
 * in the developer file.
 */
export function resolveAgentCredentials(options: { agentKey: string; apiUrl: string }, devFile: string | undefined): { ok: true; credentials: AgentCredentials } | { ok: false; problem: Problem } | undefined {
  const vars = devFile === undefined ? {} : parseEnvFile(devFile)
  const key = options.agentKey.trim() || (vars.TALKIF_AGENT_KEY ?? '').trim()
  if (!key) return undefined
  if (!key.startsWith(AGENT_KEY_PREFIX)) {
    return { ok: false, problem: { reason: 'the Personal Agent credential is not a tif_agent_ credential', next: 'paste the credential Talkif showed when you added the agent (it starts with tif_agent_)' } }
  }
  let url = normalizeApiUrl(options.apiUrl)
  if (url === undefined) return { ok: false, problem: badUrlProblem(options.apiUrl) }
  if (!options.apiUrl.trim() && vars.TALKIF_API_URL) {
    url = normalizeApiUrl(vars.TALKIF_API_URL)
    if (url === undefined) return { ok: false, problem: { reason: 'TALKIF_API_URL in the developer file is not an http:// or https:// address', next: 'fix it or remove the line' } }
  }
  const origins = (vars.TALKIF_AGENT_ORIGINS ?? '').split(',').map(o => o.trim()).filter(o => /^https:\/\/[^/\s]+$/.test(o))
  const owner =
    url === DEFAULT_API_URL
      ? { rpId: TALKIF_OWNER_ORIGIN.rpId, origins: [...TALKIF_OWNER_ORIGIN.origins] }
      : vars.TALKIF_AGENT_RP_ID && origins.length
        ? { rpId: vars.TALKIF_AGENT_RP_ID.trim(), origins }
        : undefined
  return { ok: true, credentials: { key, url, owner } }
}

// ---- /cm setup: one check per thing a user must have, each with its next step ----

/** GET /connectors/consent, the fields setup reads. */
export type Consent = {
  accepted: boolean
  /** The account's display name; absent from backends that do not send it. */
  accountName: string | undefined
  acceptedByName: string | undefined
  termsVersion: string | undefined
  currentTermsVersion: string | undefined
  withdrawnAt: string | undefined
}

const optString = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

export function parseConsent(body: unknown): Consent | undefined {
  if (!isRecord(body) || typeof body.accepted !== 'boolean') return undefined
  return {
    accepted: body.accepted,
    accountName: optString(body.accountName),
    acceptedByName: optString(body.acceptedByName),
    termsVersion: optString(body.termsVersion),
    currentTermsVersion: optString(body.currentTermsVersion),
    withdrawnAt: optString(body.withdrawnAt),
  }
}

export type Check = { name: string; ok: boolean; detail: string; next?: string }

export const KEY_STEP =
  'Create an API key in the Talkif dashboard: Developer → Credentials, with the scopes Connectors, Calls (read) and Flows (read). ' +
  'Then paste it in /plugin → call-me → Configure options → Talkif API key.'
export const CONNECTORS_STEP = 'An owner or admin of the Talkif account turns Connectors on in the dashboard: Developer → Integrations.'
export const FLOW_STEP =
  'In the Talkif flow builder add a Connectors node to an agent and publish the flow (or set flowId in /config → call-me to a flow that has one).'

/** A probe that did not return 200, as a failed check with what to do. */
export function failedProbe(name: string, scope: string, status: number, text: string): Check {
  if (text.includes('api_key_insufficient_scope')) {
    return { name, ok: false, detail: `the API key lacks the ${scope} scope`, next: `Edit the key in Developer → Credentials and add the ${scope} scope (or create a new key with Connectors, Calls (read) and Flows (read)).` }
  }
  if (text.includes('api_key_ip_restricted')) {
    return { name, ok: false, detail: 'this IP address is not on the API key allowlist', next: 'Add this IP address to the key in Developer → Credentials, or remove the restriction.' }
  }
  if (status === 401) return { name, ok: false, detail: 'the API key was refused (expired, revoked or mistyped)', next: KEY_STEP }
  if (status === 403) return { name, ok: false, detail: 'the API key is not allowed to do this', next: KEY_STEP }
  return { name, ok: false, detail: `the backend answered ${status}${text ? `: ${text.slice(0, 160)}` : ''}`, next: 'Try /cm setup again in a minute; if it stays, check the API URL option (empty means Talkif).' }
}

/** The consent body as a check: on, off (withdrawn), terms changed, or never turned on. */
export function consentCheck(consent: Consent): Check {
  const name = 'Connectors'
  if (consent.accepted) {
    return { name, ok: true, detail: `turned on for ${consent.accountName ? `the account ${consent.accountName}` : 'this account'}${consent.acceptedByName ? ` (by ${consent.acceptedByName})` : ''}` }
  }
  if (consent.withdrawnAt) {
    return { name, ok: false, detail: `turned off by an owner or admin on ${consent.withdrawnAt.slice(0, 10)}`, next: CONNECTORS_STEP }
  }
  if (consent.termsVersion && consent.currentTermsVersion && consent.termsVersion !== consent.currentTermsVersion) {
    return { name, ok: false, detail: `the Connectors terms changed (${consent.termsVersion} accepted, ${consent.currentTermsVersion} now)`, next: `${CONNECTORS_STEP} They accept the new terms there.` }
  }
  return { name, ok: false, detail: 'not turned on for this account', next: CONNECTORS_STEP }
}

/** The checks as plain text: one line each, then the first next step. */
export function setupReport(checks: readonly Check[]): string {
  const lines = ['call-me setup', ...checks.map(c => `${c.ok ? '[ok]     ' : '[missing]'} ${c.name}: ${c.detail}`)]
  const steps = checks.filter(c => !c.ok && c.next).map(c => c.next)
  if (steps.length === 0) {
    lines.push('', 'All set. Call your Talkif agent from the Talkif app (signed in), or let a session ring you with call_me.')
  } else {
    lines.push('', `Next step: ${steps[0]}`)
    for (const later of [...new Set(steps.slice(1))]) lines.push(`Then: ${later}`)
    lines.push('Run /cm setup again after each step.')
  }
  return lines.join('\n')
}

// ---- Is it on? The status line, /cm and /cm help ----

/** The account name the backend sends (register answer, consent read); undefined when it sends none. */
export const accountNameOf = (body: unknown): string | undefined =>
  isRecord(body) ? optString(typeof body.accountName === 'string' ? body.accountName.trim() : undefined) : undefined

/**
 * What the traffic pane shows a bridge as: the account's name, else the name of
 * its key slot (personal, org, …). Debug only: what users read names accounts
 * with accountsText.
 */
export const accountLabel = (slot: string, accountName: string | undefined): string => accountName ?? slot

/**
 * Accounts as a user reads them: their names from Talkif, never key slots.
 * Unnamed ones are "your Talkif account" (one) or "N Talkif accounts".
 */
export function accountsText(names: readonly (string | undefined)[]): string {
  const named = [...new Set(names.filter((n): n is string => n !== undefined))]
  const unnamed = names.length - names.filter(n => n !== undefined).length
  const parts = [...named]
  if (unnamed > 0) {
    parts.push(named.length ? `${unnamed} more Talkif account${unnamed > 1 ? 's' : ''}` : unnamed > 1 ? `${unnamed} Talkif accounts` : 'your Talkif account')
  }
  if (parts.length === 0) return 'your Talkif account'
  return parts.length === 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** What the status line and /cm read: one live state, so they never disagree with each other or /cm setup. */
export type CallMeState = {
  /** What keeps it from working (no key, no Connectors flow, access refused); undefined when nothing does. */
  problem: Problem | undefined
  /** Why this session is off: /cm off, /cm off all, or /cm default off; undefined when on. */
  off: 'session' | 'all' | 'default' | undefined
  /** An interview ringing or in progress, a call task running, or call tasks queued. */
  onCall: boolean
  /** The accounts this session is registered in now, by their Talkif name (undefined: none sent). */
  registered: readonly (string | undefined)[]
  /** The name of the flow calls run on, when known. */
  flowName: string | undefined
  /** The Personal Agent part of the status line; undefined without an agent credential. */
  agent?: string
}

const sentence = (text: string): string => {
  const t = text.trim().replace(/[.\s]+$/, '')
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}.` : ''
}

/**
 * The status line; the first matching state wins: not set up, off, on a call,
 * connecting (no account registered yet, or every one retrying), on.
 */
export function statusText(state: CallMeState): string {
  if (state.agent === undefined) return callMeStatusText(state)
  // Personal Agent alone (no Connectors key): its part only, not a "not set up" for calls.
  if (state.problem?.reason === NO_KEY_PROBLEM.reason) return state.agent
  return `${callMeStatusText(state)} · ${state.agent}`
}

function callMeStatusText(state: CallMeState): string {
  if (state.problem) return '☎ call-me: not set up — run /cm setup'
  if (state.off) return '☎ call-me: off'
  if (state.onCall) return '☎ call-me: on a call'
  if (state.registered.length === 0) return '☎ call-me: connecting…'
  const named = [...new Set(state.registered.filter((n): n is string => n !== undefined))]
  return named.length ? `☎ call-me: on · ${named.join(', ')}` : '☎ call-me: on'
}

export const MORE = 'More: /cm help'

/** /cm: two or three lines, in the same order as statusText. */
export function cmLines(state: CallMeState): string {
  if (state.problem) return [`☎ Not set up: ${state.problem.reason}.`, `Next: ${sentence(state.problem.next)}`, MORE].join('\n')
  if (state.off) return [`☎ Off. Turn it on with ${state.off === 'all' ? '/cm on all' : '/cm on'}.`, MORE].join('\n')
  if (state.registered.length === 0) return ['☎ Connecting…', MORE].join('\n')
  const call = state.flowName ? `Call "${state.flowName}" in the Talkif app.` : 'Call your Talkif agent in the Talkif app.'
  const head = state.onCall ? '☎ On a call.' : '☎ On.'
  return [`${head} This session can be reached through ${accountsText(state.registered)}.`, call, MORE].join('\n')
}

/** /cm help: the common commands first; two columns when the terminal is wide enough, else stacked. */
const HELP_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['/cm', 'is this session reachable?'],
  ['/cm on | off', 'make this session reachable or not'],
  ['/cm on all | off all', 'all open sessions on or off'],
  ['/cm default on | off', 'how new sessions start'],
  ['/cm setup', "check the connection, show what's missing"],
  ['/cm traffic', 'what went back and forth (debug option)'],
]
const HELP_ADVANCED: ReadonlyArray<readonly [string, string]> = [
  ['/cm publish', "write the call prompt into your flow"],
  ['/cm latency', 'time a spoken answer'],
]
const HELP_ALL = [...HELP_ROWS, ...HELP_ADVANCED]
const HELP_WIDTH = Math.max(...HELP_ALL.map(([cmd]) => cmd.length)) + 2
/** Cells the transcript takes before command output starts (the "⎿" gutter plus padding). */
const HELP_GUTTER = 6
const HELP_WIDE = 2 + HELP_WIDTH + Math.max(...HELP_ALL.map(([, text]) => text.length)) + HELP_GUTTER

const wideRow = ([cmd, text]: readonly [string, string]): string => `  ${cmd.padEnd(HELP_WIDTH)}${text}`
const stackedRow = ([cmd, text]: readonly [string, string]): string => `  ${cmd}\n      ${text}`

export function cmHelp(columns: number): string {
  const row = columns >= HELP_WIDE ? wideRow : stackedRow
  return ['Commands', ...HELP_ROWS.map(row), '', 'Advanced', ...HELP_ADVANCED.map(row)].join('\n')
}

export const UNKNOWN_COMMAND = 'Unknown command. See /cm help.'

/**
 * The name of the signed-in person who asked, as Talkif sends it (`callerName`),
 * made safe to put in a prompt: letters, digits, spaces and . ' - only, one line,
 * at most 60 characters. `undefined` when nothing is left.
 */
export function askerName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const name = raw.normalize('NFC').replace(/[^\p{L}\p{M}\p{N} .'-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).trim()
  return name || undefined
}
