// Generates test-vectors/tap1.json with node:crypto, independently of the
// plugin's own implementation (hooks/tap1.ts, on the vendored noble code), so
// the tests compare two implementations. Deterministic: run it again and the
// file is byte-for-byte the same.
//
//   node scripts/make-vectors.mjs > test-vectors/tap1.json
//
// The fixed inputs are the ones the Talkif Agent Protocol fixes for tap/1:
// RFC 7748 §6.1 keys, RFC 8032 §7.1 TEST 1 signing key, fixed ids and nonce.
import crypto from 'node:crypto'

const hex = h => Buffer.from(h, 'hex')
const b64u = b => Buffer.from(b).toString('base64url')
const sha256hex = b => crypto.createHash('sha256').update(b).digest('hex')

const canonicalJson = v => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const keys = Object.keys(v).filter(k => v[k] !== undefined).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
}
const withoutHub = env => Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'hub'))
const envHashOf = env => sha256hex(canonicalJson(withoutHub(env)))

const x25519Priv = raw => crypto.createPrivateKey({ key: Buffer.concat([hex('302e020100300506032b656e04220420'), raw]), format: 'der', type: 'pkcs8' })
const x25519Pub = raw => crypto.createPublicKey({ key: Buffer.concat([hex('302a300506032b656e032100'), raw]), format: 'der', type: 'spki' })
const ed25519Priv = raw => crypto.createPrivateKey({ key: Buffer.concat([hex('302e020100300506032b657004220420'), raw]), format: 'der', type: 'pkcs8' })
const rawPub = key => crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32)

const RECIPIENT_PRIV = hex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb')
const EPHEMERAL_PRIV = hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a')
const SIGNING_PRIV = hex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')
const MESSAGE_ID = '0192f000-0000-7000-8000-000000000001'
const FROM = '0192f000-0000-7000-8000-0000000000aa'
const RECIPIENT = '0192f000-0000-7000-8000-0000000000bb'
const NONCE = hex('000102030405060708090a0b')
const PLAINTEXT = `{"kind":"message","messageId":"${MESSAGE_ID}","role":"agent","parts":[{"kind":"text","text":"hello from tap/1"}]}`

const recipientPub = rawPub(x25519Priv(RECIPIENT_PRIV))
const ephemeralPub = rawPub(x25519Priv(EPHEMERAL_PRIV))
const signingPub = rawPub(ed25519Priv(SIGNING_PRIV))
const shared = crypto.diffieHellman({ privateKey: x25519Priv(EPHEMERAL_PRIV), publicKey: x25519Pub(recipientPub) })
if (shared.toString('hex') !== '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742') throw new Error('X25519 does not match RFC 7748 §6.1')

const keyFor = messageId =>
  Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([ephemeralPub, recipientPub]), Buffer.concat([Buffer.from('talkif-agent-protocol/v1/body'), Buffer.from([0]), Buffer.from(messageId)]), 32))
const gcm = (key, nonce, aad, plaintext) => {
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce)
  c.setAAD(Buffer.from(aad))
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()])
}
const sign = message => crypto.sign(null, Buffer.from(message), ed25519Priv(SIGNING_PRIV))

// The fixture envelope: keys deliberately out of order.
const envelope = {
  topics: ['ios', 'build'],
  to: { agents: [RECIPIENT] },
  v: 1,
  sizeBytes: Buffer.byteLength(PLAINTEXT),
  requestId: '0192f000-0000-7000-8000-0000000000c1',
  permission: 'local_write',
  parentTaskId: '0192f000-0000-7000-8000-0000000000d1',
  notify: 'none',
  messageId: MESSAGE_ID,
  kind: 'task',
  hub: null,
  from: FROM,
  depth: 2,
  deadlineAt: '2026-10-17T12:00:00Z',
  taskId: '0192f000-0000-7000-8000-0000000000d2',
}
const canonicalEnvelope = canonicalJson(withoutHub(envelope))
const envHash = envHashOf(envelope)
const aad = `tap/1|${envHash}|${RECIPIENT}`
const hkdfKey = keyFor(MESSAGE_ID)
const ct = gcm(hkdfKey, NONCE, aad, Buffer.from(PLAINTEXT))
const sig = sign(`tap/1-sig\n${envHash}\n${RECIPIENT}\n${sha256hex(ct)}`)

// File chunks: messageId := ticketId:seq, their own AAD and signature text.
const TICKET = '0192f000-0000-7000-8000-0000000000e1'
const FILE = Buffer.from('0123456789abcdefghij')
const chunks = [0, 1].map(seq => {
  const last = seq === 1
  const plaintext = FILE.subarray(seq * 10, seq * 10 + 10)
  const chunkAad = `tap/1-chunk|${TICKET}|${seq}|${last ? 1 : 0}|${FILE.length}|${RECIPIENT}`
  const chunkKey = keyFor(`${TICKET}:${seq}`)
  const chunkCt = gcm(chunkKey, NONCE, chunkAad, plaintext)
  return {
    seq,
    last,
    plaintext: b64u(plaintext),
    aad: chunkAad,
    hkdfKey: chunkKey.toString('hex'),
    ct: b64u(chunkCt),
    sig: b64u(sign(`tap/1-chunk-sig\n${TICKET}\n${seq}\n${sha256hex(chunkCt)}`)),
  }
})

// The session nonce (POST /self/session): sealed to the agent's own key,
// messageId := sid, its own AAD; the proof is HMAC-SHA256(nonce, "tap/1-session\n" + sid).
const SID = '0192f000-0000-7000-8000-0000000000f1'
const SESSION_NONCE = Buffer.alloc(32, 7)
const sessionAad = `tap/1-session|${SID}|${RECIPIENT}`
const sessionKey = keyFor(SID)
const sessionCt = gcm(sessionKey, NONCE, sessionAad, SESSION_NONCE)
const proof = crypto.createHmac('sha256', SESSION_NONCE).update(`tap/1-session\n${SID}`).digest()

// The action hash (§6.3).
const action = { agentId: RECIPIENT, taskId: envelope.taskId, tool: 'Bash', input: { command: 'git push origin main' }, cwd: '/repo' }
const actionPreimage = `tap/1-action\n${action.agentId}\n${action.taskId}\n${action.tool}\n${canonicalJson(action.input)}\n${action.cwd}`

const vectors = {
  v: 1,
  alg: 'X25519-HKDF-SHA256-A256GCM',
  inputs: {
    recipientPrivate: RECIPIENT_PRIV.toString('hex'),
    recipientPublic: recipientPub.toString('hex'),
    ephemeralPrivate: EPHEMERAL_PRIV.toString('hex'),
    ephemeralPublic: ephemeralPub.toString('hex'),
    signingPrivate: SIGNING_PRIV.toString('hex'),
    signingPublic: signingPub.toString('hex'),
    messageId: MESSAGE_ID,
    from: FROM,
    recipient: RECIPIENT,
    nonce: NONCE.toString('hex'),
    plaintext: PLAINTEXT,
    envelope,
  },
  shared: shared.toString('hex'),
  canonicalEnvelope,
  envHash,
  hkdfKey: hkdfKey.toString('hex'),
  aad,
  ciphertext: { v: 1, alg: 'X25519-HKDF-SHA256-A256GCM', epk: b64u(ephemeralPub), nonce: b64u(NONCE), ct: b64u(ct) },
  sig: b64u(sig),
  lowOrderPublicKey: '0000000000000000000000000000000000000000000000000000000000000000',
  chunks: { ticketId: TICKET, totalBytes: FILE.length, sha256: sha256hex(FILE), consumer: RECIPIENT, items: chunks },
  session: { sid: SID, nonce: SESSION_NONCE.toString('hex'), aad: sessionAad, sealedNonce: { v: 1, alg: 'X25519-HKDF-SHA256-A256GCM', epk: b64u(ephemeralPub), nonce: b64u(NONCE), ct: b64u(sessionCt) }, proof: b64u(proof) },
  action: { ...action, preimage: actionPreimage, actionHash: sha256hex(actionPreimage) },
}

process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`)
