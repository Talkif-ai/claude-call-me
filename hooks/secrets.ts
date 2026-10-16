// Secret-looking text never leaves this session for a call or the channel log:
// everything sent to the bridge passes through here first. The prompt rules keep
// the model from saying a secret; this catches one it read (a call task may `cat`
// a file) and repeated anyway. The backend redacts again on its side.

const REDACTED = '[redacted]'

const PATTERNS: readonly RegExp[] = [
  // Private key blocks, also one cut off before its END line.
  /-----BEGIN [A-Z0-9 ]*KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*KEY-----|$)/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\btif_(?:live|test)_[A-Za-z0-9]{8,}/g,
]
// NAME=value where the name says key, token, secret or password: the name stays.
const ASSIGNMENT = /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD))\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi

export const redactSecrets = (text: string): string =>
  PATTERNS.reduce((out, re) => out.replace(re, REDACTED), text).replace(ASSIGNMENT, `$1=${REDACTED}`)

// A request body, every string in it redacted (keys of objects are names, kept).
export const redactBody = (value: unknown): unknown => {
  if (typeof value === 'string') return redactSecrets(value)
  if (Array.isArray(value)) return value.map(redactBody)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactBody(v)]))
  }
  return value
}
