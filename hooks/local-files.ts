// Local files and the secret store for Agent Bridge: 0600 files written so no
// moment exists where others can read them, the macOS keychain for private keys,
// and the credential files /cm connect writes.

import type { EngineInterface } from 'claude-code'

import { AGENT_KEY_PREFIX, DEV_ENV_FILES } from './config'
import { isId } from './protocol'
import { keyBlob, keysFromBlob } from './tap1'
import type { KeyPair } from './tap1'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)


export async function run($: EngineInterface, argv: string[], stdin?: string) {
  return $.process.run(argv, stdin === undefined ? {} : { stdin })
}

let platform: string | undefined
export async function os($: EngineInterface): Promise<string> {
  platform ??= (await run($, ['uname', '-s'])).stdout.trim()
  return platform
}

/**
 * Write a file only its owner can read: created 0600 under umask 077 next to the
 * target, then renamed over it (no moment where it is readable by others), then
 * checked. `$.fs.write` has no mode, so this goes through the shell.
 */
export async function writePrivate($: EngineInterface, path: string, text: string): Promise<void> {
  const res = await run($, ['sh', '-c', 'umask 077 && mkdir -p "$(dirname "$1")" && cat > "$1.tmp" && mv -f "$1.tmp" "$1"', 'sh', path], text)
  if (res.exitCode !== 0) throw new Error(`could not write ${path}`)
  if (!(await isPrivate($, path))) throw new Error(`${path} is readable by others; refusing to use it`)
}

/** Mode 0600 and owned by the current user. */
export async function isPrivate($: EngineInterface, path: string): Promise<boolean> {
  const fmt = (await os($)) === 'Darwin' ? ['stat', '-f', '%Lp %u', path] : ['stat', '-c', '%a %u', path]
  const [stat, id] = await Promise.all([run($, fmt), run($, ['id', '-u'])])
  return stat.exitCode === 0 && id.exitCode === 0 && stat.stdout.trim() === `600 ${id.stdout.trim()}`
}

export async function readPrivateJson($: EngineInterface, path: string): Promise<unknown> {
  if (!(await $.fs.exists(path))) return undefined
  if (!(await isPrivate($, path))) throw new Error(`${path} is readable by others; refusing to use it`)
  try {
    return JSON.parse(await $.fs.read(path))
  } catch {
    return undefined
  }
}

const KEYCHAIN_SERVICE = 'talkif-agent'

/** An agent id that names a file or a keychain entry here: a lowercase UUID only (the hub may be compromised). */
export function checkedId(agentId: string): string {
  if (!isId(agentId)) throw new Error('Talkif sent an agent id that is not a UUID; refusing to use it')
  return agentId
}

/** Both private keys, one hex blob: the macOS keychain, else a 0600 file. Never in argv, never in $.store. */
export async function storePrivateKeys($: EngineInterface, dir: string, agentId: string, keys: KeyPair): Promise<void> {
  const blob = keyBlob(keys)
  const account = checkedId(agentId)
  if ((await os($)) === 'Darwin') {
    // `security -i` reads the whole command from stdin: the secret is never in the process list.
    // Every word is a fixed name, a UUID or hex (checked above): nothing can add a command.
    const res = await run($, ['security', '-i'], `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "${account}" -w "${blob}"\n`)
    if (res.exitCode !== 0) throw new Error('could not store the agent key in the keychain')
    return
  }
  await writePrivate($, `${dir}/${account}.key`, `${blob}\n`)
}

export async function loadPrivateKeys($: EngineInterface, dir: string, agentId: string): Promise<KeyPair | undefined> {
  if ((await os($)) === 'Darwin') {
    const res = await run($, ['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', checkedId(agentId), '-w'])
    return res.exitCode === 0 ? keysFromBlob(res.stdout) : undefined
  }
  const path = `${dir}/${checkedId(agentId)}.key`
  if (!(await $.fs.exists(path))) return undefined
  if (!(await isPrivate($, path))) throw new Error(`${path} is readable by others; refusing to use it`)
  return keysFromBlob(await $.fs.read(path))
}


/** Where /cm connect keeps a credential when the engine's secret field is not used (0600, owner-checked). */
export const CREDENTIALS_DIR = '.config/talkif/agents'
export const credentialPath = (home: string, agentId: string): string => `${home}/${CREDENTIALS_DIR}/${checkedId(agentId)}.credential`

export async function homeDir($: EngineInterface): Promise<string> {
  return (await $.process.run(['printenv', 'HOME'])).stdout.trim()
}

export async function devFileText($: EngineInterface, home: string): Promise<string | undefined> {
  for (const name of DEV_ENV_FILES) {
    if (await $.fs.exists(`${home}/${name}`)) return $.fs.read(`${home}/${name}`)
  }
  return undefined
}

/** The folder an agent is bound to on this machine, from its local binding file. */
export async function boundRootOf($: EngineInterface, home: string, agentId: string): Promise<string | undefined> {
  const saved = await readPrivateJson($, `${home}/.config/talkif/agent/${checkedId(agentId)}.json`).catch(() => undefined)
  return isRecord(saved) && typeof saved.root === 'string' ? saved.root : undefined
}

/**
 * Credentials /cm connect stored in files: the one bound to this folder, and one
 * bound nowhere yet. A file others can read is skipped, never used.
 */
export async function fileCredentials($: EngineInterface, home: string, root: string): Promise<{ bound?: string; unbound?: string }> {
  const dir = `${home}/${CREDENTIALS_DIR}`
  const found: { bound?: string; unbound?: string } = {}
  if (!(await $.fs.exists(dir))) return found
  for (const entry of await $.fs.list(dir).catch(() => [])) {
    const id = /^(.+)\.credential$/.exec(entry.name)?.[1]
    if (entry.kind !== 'file' || id === undefined || !isId(id)) continue
    const boundTo = await boundRootOf($, home, id)
    if (boundTo !== undefined && boundTo !== root) continue
    const path = credentialPath(home, id)
    if (!(await isPrivate($, path))) {
      $.ui.log(`call-me (Agent Bridge): ${path} is readable by others; not using it`)
      continue
    }
    const token = (await $.fs.read(path)).trim()
    if (!token.startsWith(AGENT_KEY_PREFIX)) continue
    if (boundTo === root) found.bound ??= token
    else found.unbound ??= token
  }
  return found
}
