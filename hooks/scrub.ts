// Agent Bridge: secret-looking text never goes into a sealed message or an action
// shown for approval. The patterns are the shared test-vectors/secrets.json (copied
// byte for byte from talkif-agents, mirrored into shared-tables.ts); this file is their
// one implementation here. On top of the patterns, this agent's own credential and
// private keys are removed by exact value (`OwnSecrets`). Sealing is end to end, so
// nothing downstream could scrub it.
//
// The Connectors bridge keeps its own redactor (secrets.ts), unchanged.

import { SECRETS_JSON } from './shared-tables'
import { b64url, toHex } from './tap1'

type PatternRow = { id: string; pattern: string; replace: string; ci?: boolean }
type SecretsTable = { v: number; redacted: string; patterns: PatternRow[] }

let cachedTable: SecretsTable | undefined
const secretsTable = (): SecretsTable => {
  if (cachedTable) return cachedTable
  // The generated mirror of secrets.json; its shape is the file's, checked by the vector tests.
  const parsed = JSON.parse(SECRETS_JSON) as SecretsTable
  if (parsed.v !== 1) throw new Error(`secrets.json v${String(parsed.v)} is not the version this plugin implements (1)`)
  cachedTable = parsed
  return parsed
}

let compiled: { re: RegExp; replace: string }[] | undefined
const patterns = (): { re: RegExp; replace: string }[] => {
  compiled ??= secretsTable().patterns.map(p => ({ re: new RegExp(p.pattern, p.ci ? 'gi' : 'g'), replace: p.replace }))
  return compiled
}

/** Every pattern of secrets.json applied in order, each to the output of the one before. */
export const redactSecrets = (text: string): string => patterns().reduce((out, p) => out.replace(p.re, p.replace), text)

const b64 = (bytes: Uint8Array): string => {
  const plain = b64url(bytes).replace(/-/g, '+').replace(/_/g, '/')
  return plain + '='.repeat((4 - (plain.length % 4)) % 4)
}

/**
 * This agent's own secret values, in every textual form a run could print them: the
 * credential, and each private key as base64url, base64 (with and without padding) and hex.
 */
export class OwnSecrets {
  private readonly forms: string[]

  constructor(input: { credential?: string; keys?: readonly Uint8Array[] }) {
    const forms = new Set<string>()
    if (input.credential) forms.add(input.credential)
    for (const key of input.keys ?? []) {
      if (key.length === 0) continue
      const padded = b64(key)
      for (const f of [b64url(key), padded, padded.replace(/=+$/, ''), toHex(key), toHex(key).toUpperCase()]) forms.add(f)
    }
    // Longest first, so a padded form is removed whole before its unpadded prefix.
    this.forms = [...forms].filter(f => f.length >= 16).sort((a, b) => b.length - a.length)
  }

  contains(text: string): boolean {
    return this.forms.some(f => text.includes(f))
  }

  redact(text: string): string {
    const redacted = secretsTable().redacted
    return this.forms.reduce((out, f) => out.split(f).join(redacted), text)
  }
}

/** This agent's own values first (exact, before a pattern could cut one apart), then the patterns. */
export const scrub = (text: string, own?: OwnSecrets): string => redactSecrets(own ? own.redact(text) : text)

/** A JSON value with every string in it scrubbed (object keys are names and stay). */
export const scrubBody = (value: unknown, own?: OwnSecrets): unknown => {
  if (typeof value === 'string') return scrub(value, own)
  if (Array.isArray(value)) return value.map(v => scrubBody(v, own))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubBody(v, own)]))
  }
  return value
}
