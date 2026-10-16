// The User-Agent every connector sends to the backend: talkif-call-me/<version>,
// the version read from the plugin's own manifest, so it never drifts from it.
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"));
export const USER_AGENT = `talkif-call-me/${manifest.version}`;
