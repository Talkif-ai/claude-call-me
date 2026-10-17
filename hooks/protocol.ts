// Agent Bridge: the shapes Talkif's hub and this plugin exchange, and the pure
// decisions about them (what to accept, what to send, which permission a peer task
// runs with, how an owner's passkey proof is checked, what the status line says).
// No engine calls here, so every rule is tested on its own.

import { OwnSecrets, scrubBody } from './scrub'
import {
  b64url,
  bodyAad,
  bodySigText,
  canonicalJson,
  envelopeHash,
  equalBytes,
  fromB64url,
  fromUtf8,
  open,
  seal,
  sha256Hex,
  signText,
  utf8,
  uuidv7,
  verifyText,
} from './tap1'
import type { Ciphertext, KeyPair } from './tap1'
import { ed25519, p256, sha256 } from './vendor/noble/noble.js'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const optString = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [])

// ---- closed lists, equal to test-vectors/refusals.json and kinds.json ----

export const REFUSALS = [
  'already_bid', 'another_approval_announced', 'approval_denied', 'approval_expired', 'approval_mismatch', 'approval_required', 'approval_used',
  'bad_ciphertext', 'bid_round_closed', 'body_too_large', 'budget_exhausted', 'caller_did_not_answer', 'canceled', 'cannot_revoke_phone',
  'card_not_set', 'connect_already_decided', 'connect_code_invalid', 'credential_already_issued', 'credential_revoked', 'cycle', 'deadline_passed', 'depth_limit', 'envelope_too_large', 'expired',
  'file_unavailable', 'guard_unavailable', 'hidden_characters', 'idempotency_conflict', 'inbox_full', 'invalid_envelope', 'invalid_kind', 'invalid_transition',
  'key_already_set', 'key_not_set', 'live_agents_limit', 'may_not_delegate', 'mode_forbids_write', 'no_bidder', 'no_capable_agent',
  'no_personal_account', 'not_announced_here', 'not_enabled', 'not_owner_call', 'not_personal_call', 'not_task_party', 'open_tasks_limit',
  'owner_proof_required', 'paused', 'rate_limited', 'receiver_mismatch', 'relay_not_allowed', 'request_closed', 'sender_may_not_assign_writes',
  'session_invalid', 'session_superseded', 'slow_down', 'target_not_found', 'too_many_recipients', 'voice_code_missing',
] as const
export type Refusal = (typeof REFUSALS)[number]

export const CLIENT_KINDS = ['message', 'task', 'status', 'result'] as const
export const HUB_KINDS = ['bid_request', 'bid_outcome', 'file_request', 'approval_update', 'task_canceled'] as const
export const KINDS = [...CLIENT_KINDS, ...HUB_KINDS] as const
/** What the hub itself may send with no body: its own kinds, and `status` reflecting a task transition it made (failed, rejected, expired, canceled). */
export const HUB_SENDABLE = [...HUB_KINDS, 'status'] as const
export type ClientKind = (typeof CLIENT_KINDS)[number]
export type HubKind = (typeof HUB_KINDS)[number]
export type Kind = ClientKind | HubKind

const isClientKind = (k: unknown): k is ClientKind => typeof k === 'string' && (CLIENT_KINDS as readonly string[]).includes(k)
const isHubKind = (k: unknown): k is HubKind => typeof k === 'string' && (HUB_KINDS as readonly string[]).includes(k)

/** The refusal code a hub answer carries (`meta.refusal`), when it is one we know. */
export function refusalOf(text: string): Refusal | undefined {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return undefined
  }
  const meta = isRecord(body) && isRecord(body.meta) ? body.meta : isRecord(body) && isRecord(body.error) && isRecord(body.error.meta) ? body.error.meta : undefined
  const code = meta?.refusal
  return typeof code === 'string' && (REFUSALS as readonly string[]).includes(code) ? (code as Refusal) : undefined
}

// ---- ids from the hub ----

/** An agent, task, request or message id: a lowercase UUID. Anything else from the hub is refused (it names files and keychain entries here). */
export const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const isId = (v: unknown): v is string => typeof v === 'string' && AGENT_ID.test(v)
const optId = (v: unknown): string | undefined | false => (v === undefined || v === null ? undefined : isId(v) ? v : false)

// ---- names from the hub, as safe to show ----

/** A name, machine or project from the hub: the hub's charset only, one short line. */
export function displayName(raw: unknown, max = 48, extra = ''): string {
  if (typeof raw !== 'string') return 'agent'
  const allowed = new RegExp(`[^A-Za-z0-9 ._${extra}-]`, 'g')
  const clean = raw.replace(allowed, ' ').replace(/\s+/g, ' ').trim().replace(/^[^A-Za-z0-9]+/, '').slice(0, max).trim()
  return clean || 'agent'
}

// ---- what the hub answers ----

export type HubMode = 'read_only' | 'auto' | 'ask_everything'
export type SelfInfo = { agentId: string; keySet: boolean; receiver: string | undefined; mode: HubMode; localWriteGranted: boolean; paused: boolean; name: string }

const isMode = (v: unknown): v is HubMode => v === 'read_only' || v === 'auto' || v === 'ask_everything'

export function parseSelf(body: unknown): SelfInfo | undefined {
  if (!isRecord(body) || !isId(body.agentId) || typeof body.keySet !== 'boolean') return undefined
  const card = isRecord(body.card) ? body.card : {}
  return {
    agentId: body.agentId,
    keySet: body.keySet,
    receiver: optString(body.receiver),
    // Unknown mode: the strictest.
    mode: isMode(body.mode) ? body.mode : 'read_only',
    localWriteGranted: isRecord(body.granted) && body.granted.localWrite === true,
    paused: body.paused === true,
    name: displayName(card.name),
  }
}

export type Peer = { agentId: string; kind: string; name: string; machine: string | undefined; project: string | undefined; capabilities: string[]; online: boolean; boxPublic: Uint8Array | undefined; signPublic: Uint8Array | undefined }

const key32 = (v: unknown): Uint8Array | undefined => {
  const bytes = typeof v === 'string' ? fromB64url(v) : undefined
  return bytes && bytes.length === 32 ? bytes : undefined
}

export function parsePeers(body: unknown): Peer[] {
  if (!isRecord(body) || !Array.isArray(body.peers)) return []
  return body.peers.flatMap(p =>
    isRecord(p) && isId(p.agentId)
      ? [{
          agentId: p.agentId,
          kind: displayName(p.kind, 16),
          name: displayName(p.name),
          machine: typeof p.machine === 'string' ? displayName(p.machine) : undefined,
          project: typeof p.project === 'string' ? displayName(p.project, 48, '/') : undefined,
          capabilities: stringList(p.capabilities).filter(c => /^[a-z0-9][a-z0-9-]{0,31}$/.test(c)).slice(0, 16),
          online: p.presence === 'online',
          boxPublic: key32(p.publicKey),
          signPublic: key32(p.signingKey),
        }]
      : [],
  )
}

export type TaskState = 'submitted' | 'needs_approval' | 'working' | 'input_required' | 'completed' | 'canceled' | 'failed' | 'rejected'
export type TaskInfo = {
  taskId: string
  requestId: string
  parentTaskId: string | undefined
  depth: number
  fromAgentId: string
  fromAgentName: string
  toAgentId: string | undefined
  state: TaskState
  permission: 'read' | 'local_write'
  granted: 'read' | 'local_write'
  deadlineAt: string
  refusal: string | undefined
}
const TASK_STATES: readonly TaskState[] = ['submitted', 'needs_approval', 'working', 'input_required', 'completed', 'canceled', 'failed', 'rejected']
export const OPEN_STATES: readonly TaskState[] = ['submitted', 'needs_approval', 'working', 'input_required']

export function parseTask(body: unknown): TaskInfo | undefined {
  const t = isRecord(body) && isRecord(body.task) ? body.task : body
  if (!isRecord(t) || !isId(t.taskId) || !isId(t.requestId) || !isId(t.fromAgentId)) return undefined
  const state = TASK_STATES.find(s => s === t.state)
  const parentTaskId = optId(t.parentTaskId)
  const toAgentId = optId(t.toAgentId)
  if (!state || parentTaskId === false || toAgentId === false) return undefined
  // `granted` beside the task (GET /tasks/{id}) or on it; anything but local_write is read.
  const granted = (isRecord(body) && body.granted === 'local_write') || t.granted === 'local_write' ? 'local_write' : 'read'
  return {
    taskId: t.taskId,
    requestId: t.requestId,
    parentTaskId,
    depth: typeof t.depth === 'number' ? t.depth : 1,
    fromAgentId: t.fromAgentId,
    fromAgentName: displayName(t.fromAgentName),
    toAgentId,
    state,
    permission: t.permission === 'local_write' ? 'local_write' : 'read',
    granted,
    deadlineAt: typeof t.deadlineAt === 'string' ? t.deadlineAt : new Date(Date.now() + 2 * 3_600_000).toISOString(),
    refusal: optString(t.refusal),
  }
}

// ---- the envelope ----

export type Envelope = {
  v: 1
  messageId: string
  kind: Kind
  from: string
  to: { agents: string[] } | { capabilities: string[]; topics?: string[] }
  topics: string[]
  requestId: string | null
  taskId: string | null
  parentTaskId: string | null
  depth: number
  deadlineAt: string
  permission: 'read' | 'local_write'
  notify: 'call' | 'note' | 'none'
  sizeBytes: number
  hub: null | Record<string, unknown>
}

function parseEnvelope(v: unknown): Envelope | undefined {
  // `from` is a sender's agent id, or "hub" on an item the hub made itself.
  if (!isRecord(v) || v.v !== 1 || !isId(v.messageId) || !(isId(v.from) || v.from === 'hub')) return undefined
  if (!isClientKind(v.kind) && !isHubKind(v.kind)) return undefined
  const to = isRecord(v.to) ? v.to : {}
  for (const id of [v.requestId, v.taskId, v.parentTaskId]) if (optId(id) === false) return undefined
  if (Array.isArray(to.agents) && !to.agents.every(isId)) return undefined
  const nullable = (x: unknown): string | null => (typeof x === 'string' ? x : null)
  return {
    v: 1,
    messageId: v.messageId,
    kind: v.kind,
    from: v.from,
    to: Array.isArray(to.agents) ? { agents: stringList(to.agents) } : { capabilities: stringList(to.capabilities), topics: stringList(to.topics) },
    topics: stringList(v.topics),
    requestId: nullable(v.requestId),
    taskId: nullable(v.taskId),
    parentTaskId: nullable(v.parentTaskId),
    depth: typeof v.depth === 'number' ? v.depth : 0,
    deadlineAt: typeof v.deadlineAt === 'string' ? v.deadlineAt : '',
    permission: v.permission === 'local_write' ? 'local_write' : 'read',
    notify: v.notify === 'call' || v.notify === 'note' ? v.notify : 'none',
    sizeBytes: typeof v.sizeBytes === 'number' ? v.sizeBytes : 0,
    hub: isRecord(v.hub) ? v.hub : null,
  }
}

export type InboxItem = { deliveryId: string; lane: 'control' | 'inbox'; raw: Record<string, unknown>; body: unknown; sig: string | null; redelivered: boolean }

export function parseInbox(body: unknown): InboxItem[] {
  if (!isRecord(body) || !Array.isArray(body.items)) return []
  return body.items.flatMap(i =>
    isRecord(i) && typeof i.deliveryId === 'string' && isRecord(i.envelope)
      ? [{ deliveryId: i.deliveryId, lane: i.lane === 'control' ? 'control' : 'inbox', raw: i.envelope, body: i.body ?? null, sig: typeof i.sig === 'string' ? i.sig : null, redelivered: i.redelivered === true }]
      : [],
  )
}

/** A pinned peer: the keys first seen for it (TOFU), or the ones the user confirmed since. */
export type PeerPin = { boxPublic: string; signPublic: string; name: string }

/** An A2A message as it travels inside a body. */
export type A2AMessage = {
  kind: 'message'
  messageId: string
  role: 'agent'
  contextId?: string
  taskId?: string
  parts: Array<{ kind: 'text'; text: string } | { kind: 'data'; data: Record<string, unknown> }>
  metadata?: { code?: Record<string, string> }
}

export type Accepted =
  | { type: 'hub'; kind: HubKind | 'status'; envelope: Envelope; hub: Record<string, unknown> }
  | { type: 'body'; envelope: Envelope; text: string; data: Record<string, unknown>[]; code: Record<string, string> | undefined }
  | { type: 'unknown-peer'; from: string }
  | { type: 'drop'; reason: string }

/**
 * One inbox item, judged: a hub item only when its body is null and its kind is a
 * hub kind; a body only when its signature verifies against the sender's pinned
 * key, it opens with our key under the envelope's AAD, and the ids inside match
 * the envelope's. Everything else is dropped (never shown to the model).
 */
export function acceptItem(item: InboxItem, selfId: string, selfKeys: KeyPair, pins: Readonly<Record<string, PeerPin>>, now = Date.now()): Accepted {
  const envelope = parseEnvelope(item.raw)
  if (!envelope) return { type: 'drop', reason: 'malformed envelope' }
  if (item.body === null) {
    // A hub item: a hub kind, or `status` the hub sends for a transition it made. Only a hint: nothing runs on it.
    if (envelope.from !== 'hub') return { type: 'drop', reason: 'no body on a client kind' }
    if (isHubKind(envelope.kind)) return { type: 'hub', kind: envelope.kind, envelope, hub: envelope.hub ?? {} }
    if (envelope.kind === 'status') return { type: 'hub', kind: 'status', envelope, hub: envelope.hub ?? {} }
    return { type: 'drop', reason: 'no body on a client kind' }
  }
  if (!isClientKind(envelope.kind)) return { type: 'drop', reason: 'a body on a hub kind' }
  if (envelope.hub !== null) return { type: 'drop', reason: 'hub data on a body item' }
  if (envelope.from === 'hub') return { type: 'drop', reason: 'a body from the hub' }
  // An old body redelivered after its deadline is never acted on (a restart forgets what was seen).
  const deadline = Date.parse(envelope.deadlineAt)
  if (!Number.isFinite(deadline) || deadline < now) return { type: 'drop', reason: 'past its deadline' }
  const pin = Object.hasOwn(pins, envelope.from) ? pins[envelope.from] : undefined
  if (!pin) return { type: 'unknown-peer', from: envelope.from }
  const signPublic = fromB64url(pin.signPublic)
  if (!signPublic || !item.sig) return { type: 'drop', reason: 'unsigned' }
  const ctBytes = isRecord(item.body) && typeof item.body.ct === 'string' ? fromB64url(item.body.ct) : undefined
  if (!ctBytes) return { type: 'drop', reason: 'bad ciphertext' }
  const envHash = envelopeHash(item.raw)
  if (!verifyText(bodySigText(envHash, selfId, ctBytes), item.sig, signPublic)) return { type: 'drop', reason: 'bad signature' }
  const plain = open(item.body, selfKeys.boxPrivate, envelope.messageId, bodyAad(envHash, selfId))
  if (!plain) return { type: 'drop', reason: 'bad ciphertext' }
  let msg: unknown
  try {
    msg = JSON.parse(fromUtf8(plain))
  } catch {
    return { type: 'drop', reason: 'plaintext is not JSON' }
  }
  if (!isRecord(msg) || msg.messageId !== envelope.messageId) return { type: 'drop', reason: 'messageId mismatch' }
  if ((optString(msg.taskId) ?? null) !== envelope.taskId) return { type: 'drop', reason: 'taskId mismatch' }
  if ((optString(msg.contextId) ?? null) !== envelope.requestId) return { type: 'drop', reason: 'contextId mismatch' }
  const parts = Array.isArray(msg.parts) ? msg.parts.filter(isRecord) : []
  const text = parts.flatMap(p => (p.kind === 'text' && typeof p.text === 'string' ? [p.text] : [])).join('\n')
  const data = parts.flatMap(p => (p.kind === 'data' && isRecord(p.data) ? [p.data] : []))
  const meta = isRecord(msg.metadata) && isRecord(msg.metadata.code) ? msg.metadata.code : undefined
  const code = meta ? Object.fromEntries(Object.entries(meta).filter((e): e is [string, string] => typeof e[1] === 'string').map(([k, v]) => [k, v.slice(0, 300)])) : undefined
  return { type: 'body', envelope, text, data, code }
}

export type Recipient = { agentId: string; boxPublic: Uint8Array }
export type Body = { recipient: string; ct: Ciphertext; sig: string }

/**
 * The envelope and one sealed, signed body per recipient. Every string of the
 * message is scrubbed of secrets here, before it is serialized: nothing reaches a
 * seal unscrubbed. Undefined when a recipient key is unusable.
 */
export function sealMessage(
  base: Omit<Envelope, 'v' | 'messageId' | 'sizeBytes' | 'hub'> & { messageId?: string },
  message: { parts: A2AMessage['parts']; metadata?: A2AMessage['metadata'] },
  recipients: readonly Recipient[],
  keys: KeyPair,
  own: OwnSecrets = new OwnSecrets({ keys: [keys.boxPrivate, keys.signPrivate] }),
): { envelope: Envelope; bodies: Body[] } | undefined {
  const messageId = base.messageId ?? uuidv7()
  const scrubbed = scrubBody(message, own)
  const clean = isRecord(scrubbed) ? scrubbed : {}
  const plain: Record<string, unknown> = { kind: 'message', messageId, role: 'agent', parts: clean.parts ?? [] }
  if (base.requestId) plain.contextId = base.requestId
  if (base.taskId) plain.taskId = base.taskId
  if (clean.metadata) plain.metadata = clean.metadata
  const plaintext = utf8(JSON.stringify(plain))
  const envelope: Envelope = { ...base, v: 1, messageId, sizeBytes: plaintext.length, hub: null }
  const envHash = envelopeHash(envelope as unknown as Record<string, unknown>)
  const bodies: Body[] = []
  for (const r of recipients) {
    const sealed = seal(plaintext, r.boxPublic, messageId, bodyAad(envHash, r.agentId))
    if (!sealed) return undefined
    bodies.push({ recipient: r.agentId, ct: sealed.ciphertext, sig: signText(bodySigText(envHash, r.agentId, sealed.ct), keys.signPrivate) })
  }
  return { envelope, bodies }
}

// ---- the permission a peer task runs with (§6.1) ----

/** peerTasks option: the local ceiling on this machine. */
export type LocalCeiling = 'read-only' | 'follow-hub'
export type PeerMode = 'read_only' | 'auto' | 'ask_everything'

/** min(hub mode, local ceiling, what the hub granted this task): read-only unless all three allow writing. */
export function effectiveMode(hub: { mode: HubMode; localWriteGranted: boolean }, local: LocalCeiling, granted: 'read' | 'local_write'): PeerMode {
  if (local !== 'follow-hub' || granted !== 'local_write' || !hub.localWriteGranted || hub.mode === 'read_only') return 'read_only'
  return hub.mode
}

// ---- owner proof: the person's passkey over the action hash (§6.5) ----

export type OwnerKey = { credentialId: string; alg: 'ES256' | 'EdDSA'; cose: Uint8Array; fingerprint: string }

// A minimal CBOR reader: enough for a COSE public key (a map of small ints to ints and byte strings).
type Cbor = number | Uint8Array | string | Cbor[] | Map<number | string, Cbor>
function readCbor(bytes: Uint8Array, at: { i: number }, depth = 0): Cbor {
  if (depth > 4) throw new Error('cbor: too deep')
  const first = bytes[at.i++]
  if (first === undefined) throw new Error('cbor: short')
  const major = first >> 5
  const info = first & 31
  let len: number
  if (info < 24) len = info
  else if (info === 24) len = bytes[at.i++] ?? 0
  else if (info === 25) len = ((bytes[at.i++] ?? 0) << 8) | (bytes[at.i++] ?? 0)
  else throw new Error('cbor: unsupported length')
  if (major === 0) return len
  if (major === 1) return -1 - len
  if (major === 2 || major === 3) {
    const chunk = bytes.slice(at.i, at.i + len)
    if (chunk.length !== len) throw new Error('cbor: short')
    at.i += len
    return major === 2 ? chunk : fromUtf8(chunk)
  }
  if (major === 4) return Array.from({ length: len }, () => readCbor(bytes, at, depth + 1))
  if (major === 5) {
    const map = new Map<number | string, Cbor>()
    for (let n = 0; n < len; n++) {
      const k = readCbor(bytes, at, depth + 1)
      if (typeof k !== 'number' && typeof k !== 'string') throw new Error('cbor: bad key')
      map.set(k, readCbor(bytes, at, depth + 1))
    }
    return map
  }
  throw new Error('cbor: unsupported type')
}

/** The verifying key of a COSE public key: P-256 uncompressed (ES256) or Ed25519 (EdDSA). */
export function coseKey(cose: Uint8Array): { alg: 'ES256' | 'EdDSA'; key: Uint8Array } | undefined {
  let m: Cbor
  try {
    const at = { i: 0 }
    m = readCbor(cose, at)
    if (at.i !== cose.length) return undefined
  } catch {
    return undefined
  }
  if (!(m instanceof Map)) return undefined
  const x = m.get(-2)
  if (m.get(1) === 2 && m.get(-1) === 1 && (m.get(3) === undefined || m.get(3) === -7)) {
    const y = m.get(-3)
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) return undefined
    const key = new Uint8Array(65)
    key[0] = 4
    key.set(x, 1)
    key.set(y, 33)
    return { alg: 'ES256', key }
  }
  if (m.get(1) === 1 && m.get(-1) === 6 && (m.get(3) === undefined || m.get(3) === -8)) {
    if (!(x instanceof Uint8Array) || x.length !== 32) return undefined
    return { alg: 'EdDSA', key: x }
  }
  return undefined
}

/** The fingerprint a person compares with the dashboard: sha256 of the COSE key, 16 hex in groups of four. */
export const ownerFingerprint = (cose: Uint8Array): string => (sha256Hex(cose).slice(0, 16).match(/.{4}/g) ?? []).join(' ')

/** GET /self/owner-keys, each key parsed and fingerprinted here (the hub's fingerprint is not trusted). */
export function parseOwnerKeys(body: unknown): OwnerKey[] {
  if (!isRecord(body) || !Array.isArray(body.keys)) return []
  return body.keys.flatMap(k => {
    if (!isRecord(k) || typeof k.credentialId !== 'string' || typeof k.publicKey !== 'string') return []
    const cose = fromB64url(k.publicKey)
    const parsed = cose ? coseKey(cose) : undefined
    return cose && parsed ? [{ credentialId: k.credentialId, alg: parsed.alg, cose, fingerprint: ownerFingerprint(cose) }] : []
  })
}

export type OwnerProof = { credentialId: string; authenticatorData: string; clientDataJSON: string; signature: string }

export function parseOwnerProof(v: unknown): OwnerProof | undefined {
  if (!isRecord(v)) return undefined
  const { credentialId, authenticatorData, clientDataJSON, signature } = v
  if (typeof credentialId !== 'string' || typeof authenticatorData !== 'string' || typeof clientDataJSON !== 'string' || typeof signature !== 'string') return undefined
  return { credentialId, authenticatorData, clientDataJSON, signature }
}

/** Which relying party and origins an owner proof must come from. */
export type OwnerOrigin = { rpId: string; origins: readonly string[] }

/** The challenge the dashboard asks the passkey to sign, base64url as clientDataJSON carries it. */
export const approvalChallenge = (approvalId: string, actionHash: string): string => b64url(sha256(utf8(`tap/1-approve\n${approvalId}\n${actionHash}`)))

/**
 * Whether `proof` is the person's passkey approving exactly this action: right
 * ceremony, challenge computed here from our own approval id and action hash, an
 * allowed origin, the relying party's hash, user verification, and a valid
 * signature under one of the keys the person confirmed on this machine.
 */
export function verifyOwnerProof(proof: OwnerProof, approvalId: string, actionHashHex: string, pinned: readonly OwnerKey[], origin: OwnerOrigin): { ok: true } | { ok: false; reason: string } {
  const key = pinned.find(k => k.credentialId === proof.credentialId)
  if (!key) return { ok: false, reason: 'the passkey is not one confirmed on this machine' }
  const clientBytes = fromB64url(proof.clientDataJSON)
  const authData = fromB64url(proof.authenticatorData)
  const signature = fromB64url(proof.signature)
  if (!clientBytes || !authData || !signature || authData.length < 37) return { ok: false, reason: 'malformed proof' }
  let client: unknown
  try {
    client = JSON.parse(fromUtf8(clientBytes))
  } catch {
    return { ok: false, reason: 'malformed client data' }
  }
  if (!isRecord(client) || client.type !== 'webauthn.get') return { ok: false, reason: 'not a passkey sign-in ceremony' }
  if (client.challenge !== approvalChallenge(approvalId, actionHashHex)) return { ok: false, reason: 'the proof is for another action' }
  if (typeof client.origin !== 'string' || !origin.origins.includes(client.origin)) return { ok: false, reason: 'the proof came from another site' }
  if (!equalBytes(authData.slice(0, 32), sha256(utf8(origin.rpId)))) return { ok: false, reason: 'the proof is for another site' }
  const flags = authData[32] ?? 0
  if ((flags & 0x01) === 0 || (flags & 0x04) === 0) return { ok: false, reason: 'the passkey did not verify the user' }
  const signed = new Uint8Array(authData.length + 32)
  signed.set(authData, 0)
  signed.set(sha256(clientBytes), authData.length)
  const parsed = coseKey(key.cose)
  if (!parsed) return { ok: false, reason: 'unusable pinned key' }
  let valid = false
  try {
    valid =
      parsed.alg === 'ES256'
        ? p256.verify(signature, sha256(signed), parsed.key, { lowS: false, prehash: false, format: 'der' })
        : ed25519.verify(signature, signed, parsed.key, { zip215: false })
  } catch {
    valid = false
  }
  return valid ? { ok: true } : { ok: false, reason: 'the signature does not verify' }
}

// ---- what the person sees: status and context lines ----

export type AgentStatus = { online: number; inbox: number; running: number; approvals: number; note: string | undefined }

/** The Agent Bridge part of the status line. `note` (bound elsewhere, standby, a problem) replaces the counts. */
export function agentStatusText(s: AgentStatus): string {
  if (s.note) return `Talkif · ${s.note}`
  const parts = [`${s.online} agent${s.online === 1 ? '' : 's'} online`]
  if (s.inbox > 0) parts.push(`inbox ${s.inbox}`)
  if (s.running > 0) parts.push(`${s.running} running`)
  if (s.approvals > 0) parts.push(`${s.approvals} approval${s.approvals === 1 ? '' : 's'}`)
  return `Talkif · ${parts.join(' · ')}`
}

/** The context line at session start: at most 8 agents, 400 characters. */
export function agentsContextLine(peers: readonly Peer[]): string | undefined {
  if (peers.length === 0) return undefined
  const head = 'Connected agents you can reach: '
  let line = head
  for (const p of peers.slice(0, 8)) {
    const item = `${p.name} (${[p.kind, p.machine].filter(Boolean).join(', ')})`
    const next = line === head ? `${line}${item}` : `${line}; ${item}`
    if (next.length > 400) break
    line = next
  }
  return line === head ? undefined : line
}

/** Compare served keys with the pin: same, first sight, or changed (refused until confirmed). */
export function pinVerdict(pin: PeerPin | undefined, peer: Peer): 'same' | 'new' | 'changed' | 'no-key' {
  if (!peer.boxPublic || !peer.signPublic) return 'no-key'
  if (!pin) return 'new'
  const box = fromB64url(pin.boxPublic)
  const sign = fromB64url(pin.signPublic)
  return box && sign && equalBytes(box, peer.boxPublic) && equalBytes(sign, peer.signPublic) ? 'same' : 'changed'
}

/** The canonical, scrubbed input of an action: what is hashed, shown and run; undefined when scrubbing changed it. */
export function canonicalActionInput(input: unknown, own?: OwnSecrets): string | undefined {
  const text = canonicalJson(input ?? {})
  return canonicalJson(scrubBody(input ?? {}, own)) === text ? text : undefined
}

// ---- hidden characters in what the person approves (§6.3) ----

// Controls, format characters (bidi overrides and isolates, zero-width, tags), line
// and paragraph separators, and every space but the plain one: what makes text read
// as something it is not.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/gu

/** `text` with every hidden character shown as `\uXXXX` (one per UTF-16 unit), and whether it had any. */
export function revealHidden(text: string): { shown: string; hidden: boolean } {
  let hidden = false
  const shown = text.replace(HIDDEN, ch => {
    if (ch === ' ') return ch
    hidden = true
    return Array.from({ length: ch.length }, (_, i) => `\\u${ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`).join('')
  })
  return { shown, hidden }
}
