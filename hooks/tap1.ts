// The Talkif Agent Protocol, wire crypto "tap/1": how a connected agent seals a
// message body to each recipient, signs it, and opens what it receives.
// Pure functions over the vendored noble code; no engine calls, so every step is
// tested against test-vectors/tap1.json (made independently with node:crypto).
//
//   X25519 ephemeral-static ECDH → HKDF-SHA256 → AES-256-GCM, one copy per
//   recipient; the AAD binds the whole envelope; Ed25519 signs who sent it.

import { ed25519, gcm, hkdf, hmac, sha256, x25519 } from './vendor/noble/noble.js'

export const ALG = 'X25519-HKDF-SHA256-A256GCM'

export type Ciphertext = { v: 1; alg: typeof ALG; epk: string; nonce: string; ct: string }

/** One agent's long-term keys: X25519 for sealing, Ed25519 for signing (32 bytes each). */
export type KeyPair = { boxPrivate: Uint8Array; boxPublic: Uint8Array; signPrivate: Uint8Array; signPublic: Uint8Array }

const enc = new TextEncoder()
const dec = new TextDecoder()

export const utf8 = (text: string): Uint8Array => enc.encode(text)
export const fromUtf8 = (bytes: Uint8Array): string => dec.decode(bytes)

// ---- encodings: base64url without padding, hex ----

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export function b64url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63)
    if (i + 1 < bytes.length) out += B64.charAt((n >> 6) & 63)
    if (i + 2 < bytes.length) out += B64.charAt(n & 63)
  }
  return out
}

/** Undefined for anything that is not canonical base64url without padding. */
export function fromB64url(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const ch of text) {
    buffer = (buffer << 6) | B64.indexOf(ch)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
  }
  // Leftover bits must be zero, or two spellings would decode to the same bytes.
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return undefined
  return Uint8Array.from(out)
}

export const toHex = (bytes: Uint8Array): string => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')

export function fromHex(text: string): Uint8Array | undefined {
  if (!/^(?:[0-9a-f]{2})*$/i.test(text)) return undefined
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16)
  return out
}

export const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export const sha256Hex = (data: Uint8Array | string): string => toHex(sha256(typeof data === 'string' ? utf8(data) : data))

/**
 * JSON with object keys sorted (UTF-16 code-unit order, JS's default sort), no
 * whitespace, numbers as JSON.stringify prints them; undefined members dropped.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value)
    if (text === undefined) throw new Error('canonicalJson: not a JSON value')
    return text
  }
  if (Array.isArray(value)) return `[${value.map(v => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`
  const entries = Object.entries(value).filter(([, v]) => v !== undefined)
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/** sha256 hex of the canonical envelope, its "hub" member left out (the hub may set it). */
export function envelopeHash(envelope: Record<string, unknown>): string {
  const rest = Object.fromEntries(Object.entries(envelope).filter(([k]) => k !== 'hub'))
  return sha256Hex(canonicalJson(rest))
}

export const bodyAad = (envHash: string, recipientAgentId: string): string => `tap/1|${envHash}|${recipientAgentId}`
export const chunkAad = (ticketId: string, seq: number, last: boolean, totalBytes: number, consumerAgentId: string): string =>
  `tap/1-chunk|${ticketId}|${seq}|${last ? 1 : 0}|${totalBytes}|${consumerAgentId}`
/** The AAD of the session nonce the hub seals to an agent at POST /self/session (messageId := sid). */
export const sessionAad = (sid: string, agentId: string): string => `tap/1-session|${sid}|${agentId}`

const INFO = utf8('talkif-agent-protocol/v1/body')

const isAllZero = (bytes: Uint8Array): boolean => bytes.every(b => b === 0)

function bodyKey(shared: Uint8Array, epk: Uint8Array, recipientPublic: Uint8Array, messageId: string): Uint8Array {
  return hkdf(sha256, shared, concat(epk, recipientPublic), concat(INFO, Uint8Array.of(0), utf8(messageId)), 32)
}

/** Shared X25519 secret, or undefined for a low-order public key (all-zero output) or a bad key. */
export function sharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array | undefined {
  if (privateKey.length !== 32 || publicKey.length !== 32) return undefined
  let shared: Uint8Array
  try {
    shared = x25519.getSharedSecret(privateKey, publicKey)
  } catch {
    return undefined
  }
  return isAllZero(shared) ? undefined : shared
}

export const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n))

/**
 * Seal `plaintext` to one recipient. `ephemeral` and `nonce` are for test vectors
 * only; a real seal draws both fresh. Undefined when the recipient key is unusable.
 */
export function seal(
  plaintext: Uint8Array,
  recipientPublic: Uint8Array,
  messageId: string,
  aad: string,
  fixed?: { ephemeralPrivate: Uint8Array; nonce: Uint8Array },
): { ciphertext: Ciphertext; ct: Uint8Array } | undefined {
  const esk = fixed?.ephemeralPrivate ?? x25519.utils.randomPrivateKey()
  const epk = x25519.getPublicKey(esk)
  const shared = sharedSecret(esk, recipientPublic)
  if (!shared) return undefined
  const nonce = fixed?.nonce ?? randomBytes(12)
  const ct = gcm(bodyKey(shared, epk, recipientPublic, messageId), nonce, utf8(aad)).encrypt(plaintext)
  return { ciphertext: { v: 1, alg: ALG, epk: b64url(epk), nonce: b64url(nonce), ct: b64url(ct) }, ct }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The ciphertext JSON as the wire carries it, checked; undefined when malformed. */
export function parseCiphertext(value: unknown): { epk: Uint8Array; nonce: Uint8Array; ct: Uint8Array } | undefined {
  if (!isRecord(value) || value.v !== 1 || value.alg !== ALG) return undefined
  if (typeof value.epk !== 'string' || typeof value.nonce !== 'string' || typeof value.ct !== 'string') return undefined
  const epk = fromB64url(value.epk)
  const nonce = fromB64url(value.nonce)
  const ct = fromB64url(value.ct)
  if (!epk || epk.length !== 32 || !nonce || nonce.length !== 12 || !ct || ct.length < 16) return undefined
  return { epk, nonce, ct }
}

/** Open a ciphertext sealed to us; undefined on any failure (bad_ciphertext). */
export function open(ciphertext: unknown, privateKey: Uint8Array, messageId: string, aad: string): Uint8Array | undefined {
  const parsed = parseCiphertext(ciphertext)
  if (!parsed) return undefined
  const shared = sharedSecret(privateKey, parsed.epk)
  if (!shared) return undefined
  try {
    return gcm(bodyKey(shared, parsed.epk, x25519.getPublicKey(privateKey), messageId), parsed.nonce, utf8(aad)).decrypt(parsed.ct)
  } catch {
    return undefined
  }
}

// ---- signatures: who sent it ----

export const bodySigText = (envHash: string, recipientAgentId: string, ct: Uint8Array): string =>
  `tap/1-sig\n${envHash}\n${recipientAgentId}\n${sha256Hex(ct)}`

/** What a file chunk's producer signs: the chunk's whole AAD and its ciphertext (vector `chunks.items[].sigInput`). */
export const chunkSigText = (chunkAad: string, ct: Uint8Array): string => `tap/1-chunk-sig\n${chunkAad}\n${sha256Hex(ct)}`

export const signText = (text: string, signPrivate: Uint8Array): string => b64url(ed25519.sign(utf8(text), signPrivate))

export function verifyText(text: string, signature: string, signPublic: Uint8Array): boolean {
  const sig = fromB64url(signature)
  if (!sig || sig.length !== 64 || signPublic.length !== 32) return false
  try {
    return ed25519.verify(sig, utf8(text), signPublic, { zip215: false })
  } catch {
    return false
  }
}

// ---- keys ----

export function generateKeyPair(): KeyPair {
  const boxPrivate = x25519.utils.randomPrivateKey()
  const signPrivate = ed25519.utils.randomPrivateKey()
  return { boxPrivate, boxPublic: x25519.getPublicKey(boxPrivate), signPrivate, signPublic: ed25519.getPublicKey(signPrivate) }
}

/** Both private keys as one hex blob (box first), the form the secret store keeps. */
export const keyBlob = (keys: KeyPair): string => toHex(concat(keys.boxPrivate, keys.signPrivate))

export function keysFromBlob(blob: string): KeyPair | undefined {
  const raw = fromHex(blob.trim())
  if (!raw || raw.length !== 64) return undefined
  const boxPrivate = raw.slice(0, 32)
  const signPrivate = raw.slice(32)
  return { boxPrivate, boxPublic: x25519.getPublicKey(boxPrivate), signPrivate, signPublic: ed25519.getPublicKey(signPrivate) }
}

/** Bytes' fingerprint as people compare it: first 16 hex of sha256, in groups of four. */
export const fingerprint = (bytes: Uint8Array): string => (sha256Hex(bytes).slice(0, 16).match(/.{4}/g) ?? []).join(' ')

/** An agent's key fingerprint, as the dashboard shows it: over its X25519 public key, then its Ed25519 public key (vector `keyFingerprint`). */
export const agentFingerprint = (boxPublic: Uint8Array, signPublic: Uint8Array): string => fingerprint(concat(boxPublic, signPublic))

// ---- proof of possession: the session nonce only our private key opens ----

export const sessionProof = (nonce: Uint8Array, sid: string): string => b64url(hmac(sha256, nonce, utf8(`tap/1-session\n${sid}`)))

// ---- the action hash an approval is bound to (§6.3) ----

export type Action = { agentId: string; taskId: string | undefined; tool: string; input: unknown; cwd: string }

export const actionPreimage = (a: Action): string => `tap/1-action\n${a.agentId}\n${a.taskId ?? '-'}\n${a.tool}\n${canonicalJson(a.input)}\n${a.cwd}`
export const actionHash = (a: Action): string => sha256Hex(actionPreimage(a))

// ---- ids ----

/** A UUID v7 (time-ordered), lowercase. */
export function uuidv7(now = Date.now()): string {
  const b = randomBytes(16)
  let ms = now
  for (let i = 5; i >= 0; i--) {
    b[i] = ms % 256
    ms = Math.floor(ms / 256)
  }
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80
  const h = toHex(b)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
