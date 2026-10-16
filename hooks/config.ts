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

export type Resolved = { ok: true; credentials: Credentials } | { ok: false; problem: string }

/** The options this module reads, already narrowed from PluginOptions. */
export type SetupOptions = { apiKey: string; apiUrl: string }

export const NO_KEY_PROBLEM =
  'no Talkif API key set. Create one in the Talkif dashboard (Developer → Credentials, scopes Connectors, Calls and Flows), ' +
  'then paste it in /plugin → call-me → Configure options.'

/**
 * The apiUrl option as a base URL (no trailing slash), DEFAULT_API_URL when empty,
 * or undefined when it is not an http(s) URL.
 */
export function normalizeApiUrl(raw: string): string | undefined {
  const url = raw.trim().replace(/\/+$/, '')
  if (!url) return DEFAULT_API_URL
  return /^https?:\/\/[^/\s]+/.test(url) ? url : undefined
}

export const badUrlProblem = (raw: string) =>
  `the API URL option "${raw.trim()}" is not an http:// or https:// address. Empty it to use Talkif (${DEFAULT_API_URL}).`

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
  if (!apiKey) return { ok: false, problem: `${devFileName} lacks TALKIF_API_KEY (or set the apiKey option instead)` }
  let url = optionUrl
  if (!fromOption && vars.TALKIF_API_URL) {
    const fileUrl = normalizeApiUrl(vars.TALKIF_API_URL)
    if (fileUrl === undefined) return { ok: false, problem: `TALKIF_API_URL in ${devFileName} is not an http:// or https:// address` }
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

export const NO_FLOW_PROBLEM =
  'no published flow with a Connectors node in this account. In the flow builder add a Connectors node to an agent and publish, ' +
  'or set the flowId option.'

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
export function refusalReason(status: number, text: string): string | undefined {
  if (status !== 401 && status !== 403) return undefined
  if (text.includes('connectors_consent_required')) {
    return 'Connectors are not turned on for this account: an owner or admin must turn them on in the Talkif dashboard (Developer → Integrations)'
  }
  if (text.includes('api_key_insufficient_scope')) {
    return 'the API key lacks a scope this needs (Connectors, Calls read, Flows read): edit its scopes in Developer → Credentials'
  }
  if (text.includes('api_key_ip_restricted')) return 'this IP is not on the API key allowlist'
  if (status === 401) return 'the API key was refused (expired or revoked?)'
  return 'the API key is not allowed to do this'
}

// ---- /cm setup: one check per thing a user must have, each with its next step ----

/** GET /connectors/consent, the fields setup reads. */
export type Consent = {
  accepted: boolean
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
    return { name, ok: true, detail: `turned on for this account${consent.acceptedByName ? ` (by ${consent.acceptedByName})` : ''}` }
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
