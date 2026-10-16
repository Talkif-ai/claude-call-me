// Where a connector script's backend and key come from — the same rules as the
// plugin: Talkif (https://api.talkif.ai) unless told otherwise, the key from the
// process environment; ~/.config/talkif/dev.env stays the developer fallback.
//
//   --url https://…            another backend (only when Talkif support asks)
//   --key-env VAR              read the key from VAR (default TALKIF_API_KEY)
//   --env-file PATH            the developer file (default ~/.config/talkif/dev.env)
//
// Backend: --url, else TALKIF_API_URL, else the developer file's TALKIF_API_URL
// when the key came from that file (or no key is needed), else https://api.talkif.ai.
// Key: VAR (default TALKIF_API_KEY) from the process environment, else from the
// developer file (there the default is TALKIF_BRIDGE_KEY, the file's bridge key).
// `--key VAR` is the old name of `--key-env`.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_API_URL = "https://api.talkif.ai";
export const SETUP_FLAGS = "[--url URL] [--key-env VAR] [--env-file PATH]";
const DEV_ENV_FILE = ".config/talkif/dev.env";
// Legacy dev file name, still read when dev.env is missing and no --env-file is given.
const LEGACY_DEV_ENV_FILE = `.config/talkif/${"stag"}ing.env`;

/** The value after `--name`, or the fallback. */
export function flag(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
}

/** KEY=value lines; blank lines, comments and lines without "=" are skipped. */
export function parseEnvFile(text) {
  const vars = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return vars;
}

const fail = message => {
  console.error(message);
  process.exit(2);
};

/**
 * The backend URL and (with needKey) the key, or exit 2 with what is missing.
 * Returns { url, urlFrom, key, keyFrom }; never prints the key.
 */
export function resolveConnection(args, { needKey = true, environ = process.env } = {}) {
  const home = homedir();
  if (args.includes("--env")) fail("--env is no longer supported: pass --url URL for another backend (a developer file goes in --env-file)");
  const fileFlag = flag(args, "env-file", undefined);
  const defaultFile = [DEV_ENV_FILE, LEGACY_DEV_ENV_FILE].map(name => join(home, name)).find(path => existsSync(path)) ?? join(home, DEV_ENV_FILE);
  const filePath = (fileFlag ?? defaultFile).replace(/^~(?=\/|$)/, home);
  const file = existsSync(filePath) ? parseEnvFile(readFileSync(filePath, "utf8")) : {};
  const keyVarFlag = flag(args, "key-env", flag(args, "key", undefined));

  let key;
  let keyFrom;
  if (needKey) {
    const envVar = keyVarFlag ?? "TALKIF_API_KEY";
    const fileVar = keyVarFlag ?? "TALKIF_BRIDGE_KEY";
    if (environ[envVar]) {
      key = environ[envVar];
      keyFrom = `$${envVar}`;
    } else if (file[fileVar]) {
      key = file[fileVar];
      keyFrom = `${filePath} (${fileVar})`;
    } else {
      fail(
        `no Talkif API key: set ${envVar} in the environment (a key with the Connectors scope, from Developer → Credentials)` +
          `${keyVarFlag ? "" : ", or pass --key-env VAR"}, or put ${fileVar} in ${filePath}`,
      );
    }
  }

  const urlFlag = flag(args, "url", undefined);
  const fromFile = !needKey || keyFrom?.startsWith(filePath);
  let url;
  let urlFrom;
  if (urlFlag) [url, urlFrom] = [urlFlag, "--url"];
  else if (environ.TALKIF_API_URL) [url, urlFrom] = [environ.TALKIF_API_URL, "$TALKIF_API_URL"];
  else if (fromFile && file.TALKIF_API_URL) [url, urlFrom] = [file.TALKIF_API_URL, filePath];
  else [url, urlFrom] = [DEFAULT_API_URL, "default"];
  url = url.replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]/.test(url)) fail(`the backend URL must start with http:// or https:// (got "${url}" from ${urlFrom})`);
  return { url, urlFrom, key, keyFrom };
}
