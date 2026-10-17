// Writes test-vectors/hidden.json: how a client and the dashboard show an action's
// hidden characters before anyone approves it (Personal Agent spec §6.3).
// Deterministic: run it again and the file is byte-for-byte the same.
//
//   node scripts/make-hidden-vector.mjs > test-vectors/hidden.json
//
// tap1.json, kinds.json and refusals.json are not made here: they are copied byte
// for byte from the talkif-agents repository, which generates them. This vector
// moves there too once that generator has it.

// canonicalJson: object keys sorted by UTF-16 code units, no whitespace, JSON.stringify scalars.
const canonicalJson = v => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const keys = Object.keys(v).filter(k => v[k] !== undefined).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
}

// Hidden: Unicode Cc, Cf, Zl, Zp, and every Zs but U+0020. Each UTF-16 code unit of
// one is shown as \uXXXX, hex in capitals.
const reveal = text => {
  let hidden = false
  const shown = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/gu, ch => {
    if (ch === ' ') return ch
    hidden = true
    return [...Array(ch.length).keys()].map(i => `\\u${ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`).join('')
  })
  return { shown, hidden }
}

const inputs = [
  { name: 'bidi override and zero-width space in the input', tool: 'Bash', input: { command: 'echo ‮abc​' }, cwd: '/repo' },
  { name: 'right-to-left isolate hiding the end of a command', tool: 'Bash', input: { command: 'rm -rf build ⁧# tests⁩' }, cwd: '/repo' },
  { name: 'zero-width joiner in the tool name', tool: 'Bash‍', input: { command: 'ls' }, cwd: '/repo' },
  { name: 'no-break space in the folder', tool: 'Bash', input: { command: 'ls' }, cwd: '/repo x' },
  { name: 'tag character (astral, two UTF-16 units)', tool: 'Bash', input: { command: 'echo \u{E0041}' }, cwd: '/repo' },
  { name: 'C1 control and line separator', tool: 'Bash', input: { command: 'a\u0085b c' }, cwd: '/repo' },
  { name: 'a tab is escaped by canonicalJson already: visible, not hidden', tool: 'Bash', input: { command: 'printf "a\tb"' }, cwd: '/repo' },
  { name: 'plain', tool: 'Bash', input: { command: 'git status' }, cwd: '/repo' },
]

const cases = inputs.map(c => {
  const canonicalInput = canonicalJson(c.input)
  const tool = reveal(c.tool)
  const input = reveal(canonicalInput)
  const cwd = reveal(c.cwd)
  return { name: c.name, tool: c.tool, input: c.input, cwd: c.cwd, canonicalInput, shown: { tool: tool.shown, input: input.shown, cwd: cwd.shown }, hidden: tool.hidden || input.hidden || cwd.hidden }
})

const vector = {
  v: 1,
  rule: 'hidden := Unicode Cc, Cf, Zl, Zp, and every Zs other than U+0020. Shown: each UTF-16 code unit of a hidden character as \\uXXXX (capital hex); tool, input (canonicalJson) and cwd each on their own. Any hidden character: approve is not offered (deny only); the hub refuses one in tool or cwd at POST /approvals with refusal hidden_characters.',
  refusal: 'hidden_characters',
  cases,
}
// Every non-ASCII character escaped, so the file itself carries no hidden character.
const ascii = JSON.stringify(vector, null, 2).replace(/[^\x20-\x7E\n]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
process.stdout.write(`${ascii}\n`)
