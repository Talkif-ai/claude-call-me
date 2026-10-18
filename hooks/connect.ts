// Device connect (/cm connect): connect this session to Agent Bridge without
// copying a credential. Talkif hands out a one-time code; the person compares it
// with the one shown here and approves it in the dashboard, signed in. The agent
// is created on approval and its credential comes back to this session only (the
// browser never sees it). The device secret stays in memory; the credential goes
// to the engine's secret field or a 0600 file, never to a log, $.store or argv.

import type { EngineInterface, Timer } from 'claude-code'

import { normalizeApiUrl, problemText } from './config'
import { agentApiUrl, agentSessionRoot, connectBlocker, useConnectedCredential } from './agent'
import { displayName, isId, refusalOf } from './protocol'
import { run } from './local-files'
import { VERSION } from './register'

/** The code the person compares: 8 letters of the 20 consonants, shown XXXX-XXXX. */
export const USER_CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/
const DEVICE_SECRET = /^tif_connect_[A-Za-z0-9]{43}$/
const AGENT_TOKEN = /^tif_agent_[A-Za-z0-9]{43}$/
const MAX_WAIT_S = 600
const SLOW_DOWN_S = 5
const MAX_FAILURES = 10

export type StartReply = { userCode: string; deviceSecret: string; verifyUrl: string; expiresIn: number; interval: number }
export type PollReply = { status: 'pending' | 'denied' | 'expired' } | { status: 'approved'; token: string; agentId: string; apiUrl: string }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The page to open: http(s) only, the dashboard's connect page for exactly this code (nothing else is handed to `open`). */
export function verifyUrlOk(raw: string, code: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return false
  if (url.username || url.password) return false
  return url.pathname === '/connect/agent' && url.searchParams.get('code') === code
}

export function parseStart(body: unknown): StartReply | undefined {
  if (!isRecord(body)) return undefined
  const { userCode, deviceSecret, verifyUrl, expiresIn, interval } = body
  if (typeof userCode !== 'string' || !USER_CODE.test(userCode)) return undefined
  if (typeof deviceSecret !== 'string' || !DEVICE_SECRET.test(deviceSecret)) return undefined
  if (typeof verifyUrl !== 'string' || !verifyUrlOk(verifyUrl, userCode)) return undefined
  const ttl = typeof expiresIn === 'number' && expiresIn > 0 ? Math.min(expiresIn, MAX_WAIT_S) : MAX_WAIT_S
  const every = typeof interval === 'number' && interval >= 1 && interval <= 30 ? interval : 2
  return { userCode, deviceSecret, verifyUrl, expiresIn: ttl, interval: every }
}

export function parsePoll(body: unknown): PollReply | undefined {
  if (!isRecord(body)) return undefined
  const s = body.status
  if (s === 'pending' || s === 'denied' || s === 'expired') return { status: s }
  if (s !== 'approved') return undefined
  const token = isRecord(body.credential) ? body.credential.token : undefined
  const { agentId, apiUrl } = body
  if (typeof token !== 'string' || !AGENT_TOKEN.test(token)) return undefined
  if (typeof agentId !== 'string' || !isId(agentId) || typeof apiUrl !== 'string') return undefined
  return { status: 'approved', token, agentId, apiUrl }
}

/** Same scheme, host and port: a tampered approved reply cannot send the credential elsewhere. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

type Flow = { api: string; secret: string; code: string; verifyUrl: string; name: string; interval: number; left: number; failures: number; timer: Timer | undefined }
let flow: Flow | undefined

const headers = (): Record<string, string> => ({ 'Content-Type': 'application/json', 'User-Agent': `talkif-call-me/${VERSION}` })

function waitingText(f: Flow, opened: boolean): string {
  return [
    `Agent Bridge: connect "${f.name}" (Claude Code on this computer).`,
    '',
    `  Code:  ${f.code}`,
    `  Page:  ${f.verifyUrl}${opened ? '  (opened in your browser)' : ''}`,
    '',
    'Sign in to Talkif on that page, check that it shows the same code, then press Approve.',
    'This session waits up to 10 minutes and connects by itself; there is nothing to copy.',
  ].join('\n')
}

function finish($: EngineInterface, f: Flow, text: string) {
  if (flow !== f) return
  f.timer?.cancel()
  flow = undefined
  $.ui.log(`call-me (Agent Bridge): ${text}`)
}

function next($: EngineInterface, f: Flow) {
  if (flow !== f) return
  if (f.left <= 0) return finish($, f, 'the connect code expired (10 minutes). Run /cm connect again for a new one.')
  f.left -= f.interval
  f.timer = $.clock.after(f.interval * 1000, () => {
    f.timer = undefined
    void poll($, f)
  })
}

async function poll($: EngineInterface, f: Flow): Promise<void> {
  if (flow !== f) return
  let res: { status: number; ok: boolean; text: string }
  try {
    res = await $.http.fetch(`${f.api}/api/v1/agent-connect/poll`, { method: 'POST', headers: headers(), body: JSON.stringify({ deviceSecret: f.secret }) })
  } catch {
    f.failures += 1
    if (f.failures >= MAX_FAILURES) return finish($, f, 'Talkif could not be reached for a while; nothing was connected. Run /cm connect again.')
    return next($, f)
  }
  if (res.status === 429) {
    // slow_down and rate_limited alike: wait longer (RFC 8628 §3.5).
    f.interval += SLOW_DOWN_S
    return next($, f)
  }
  if (!res.ok) {
    f.failures += 1
    if (res.status < 500 || f.failures >= MAX_FAILURES) return finish($, f, `Talkif refused the connect (${refusalOf(res.text) ?? res.status}); nothing was connected. Run /cm connect again.`)
    return next($, f)
  }
  f.failures = 0
  let body: unknown
  try {
    body = JSON.parse(res.text)
  } catch {
    body = undefined
  }
  const answer = parsePoll(body)
  if (!answer) return finish($, f, "Talkif's answer to the connect is not valid; nothing was stored. If an agent was created, revoke it in Build → Agent Bridge.")
  if (answer.status !== 'approved') {
    if (answer.status === 'pending') return next($, f)
    if (answer.status === 'denied') return finish($, f, 'the connect was denied in Talkif; nothing was connected.')
    return finish($, f, 'the connect code expired or was already used. Run /cm connect again for a new one.')
  }
  if (!sameOrigin(normalizeApiUrl(answer.apiUrl) ?? '', f.api)) {
    return finish($, f, `Talkif's answer named another API address than ${f.api}, so the credential was not used. Revoke "${f.name}" in Build → Agent Bridge and run /cm connect again.`)
  }
  // The approved answer is one time: the flow ends here whatever happens next.
  f.timer?.cancel()
  flow = undefined
  // Said first: storing in the secret field reloads the plugin, which may end this hook.
  $.ui.log(`call-me (Agent Bridge): approved in Talkif; connecting "${f.name}"…`)
  try {
    const where = await useConnectedCredential($, answer.token, answer.agentId)
    $.ui.log(`call-me (Agent Bridge): the credential of "${f.name}" is ${where}. If the Agent Bridge pane asks, compare your passkey fingerprints with the dashboard and confirm them.`)
  } catch (err) {
    $.ui.log(`call-me (Agent Bridge): the credential could not be stored here (${String(err)}). Revoke "${f.name}" in Build → Agent Bridge and run /cm connect again.`)
  }
}

/** /cm connect [name]: start a device connect and show the code; the rest happens in the background. */
export async function cmConnect($: EngineInterface, rawName: string): Promise<string> {
  const blocked = connectBlocker()
  if (blocked) return blocked
  if (flow) return waitingText(flow, false)
  const api = await agentApiUrl($)
  if (!api.ok) return `Agent Bridge: ${problemText(api.problem)}`
  const root = await agentSessionRoot($)
  const folder = root.split('/').pop() ?? ''
  const typed = rawName.trim()
  const name = displayName(typed || folder || 'claude-code')
  if (typed && name !== typed) return 'An agent name is letters, digits, spaces, "." "_" "-", up to 48 characters, starting with a letter or digit.'
  const host = (await run($, ['hostname', '-s'])).stdout.trim()
  const request = { kind: 'claude_code', name, machine: displayName(host || 'machine'), ...(folder ? { project: displayName(folder, 96, '/') } : {}) }
  let res: { status: number; ok: boolean; text: string }
  try {
    res = await $.http.fetch(`${api.url}/api/v1/agent-connect/start`, { method: 'POST', headers: headers(), body: JSON.stringify(request) })
  } catch {
    return `Agent Bridge: Talkif (${api.url}) could not be reached. Check the connection and run /cm connect again.`
  }
  if (res.status === 429) return 'Agent Bridge: too many connect codes from this network right now. Wait a few minutes, then run /cm connect again.'
  if (res.status === 503) return 'Agent Bridge: Talkif cannot connect devices right now. Try again in a minute.'
  if (!res.ok) return `Agent Bridge: Talkif refused the connect (${refusalOf(res.text) ?? res.status}).`
  let body: unknown
  try {
    body = JSON.parse(res.text)
  } catch {
    body = undefined
  }
  const start = parseStart(body)
  if (!start) return "Agent Bridge: Talkif's answer to the connect is not valid; nothing was started."
  const f: Flow = { api: api.url, secret: start.deviceSecret, code: start.userCode, verifyUrl: start.verifyUrl, name, interval: start.interval, left: start.expiresIn, failures: 0, timer: undefined }
  flow = f
  // macOS only: `open` with the checked https URL as one argv word (it cannot be read as a flag).
  const opened = (await run($, ['uname', '-s'])).stdout.trim() === 'Darwin' && (await run($, ['open', start.verifyUrl]).catch(() => ({ exitCode: 1 }))).exitCode === 0
  next($, f)
  return waitingText(f, opened)
}
