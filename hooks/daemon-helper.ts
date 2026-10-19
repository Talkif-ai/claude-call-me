// The child process that holds this session's connection to the local Agent Bridge daemon
// (talkif-agents). The plugin cannot open a Unix socket that speaks newline JSON (its
// network is fetch only), so it runs this script with `node -e` and reads its stdout.
//
//   watch <socket> <cwd> [<agent>]   register this session (as $TALKIF_AGENT, else <agent>) (session_start, client "mcp")
//                                    on one long-lived connection, then wait for its
//                                    items: the `subscribe` op when the daemon has it,
//                                    else a long-poll of `inbox`. One JSON line per event
//                                    on stdout. The daemon ends the session when this
//                                    process (and so the connection) goes away.
//   call <socket>                    one request read from stdin as {op, args}; one JSON
//                                    line {ok, result | error} on stdout.
//
// It opens no network connection, reads no key or credential file, and never puts peer
// text or answers on a command line (stdin and the socket only).
//
// stdout events of `watch`:
//   {"t":"started", sessionId, agent?, label?, folder?, repo?, branch?}
//   {"t":"mode", mode: "push" | "poll"}
//   {"t":"items", items: [...]}         daemon inbox entries, as the daemon returns them
//   {"t":"error", code, message}        session_start refused (retried after 30 s)
//   {"t":"down", message}               no daemon listens (retried with backoff)
//   {"t":"closed"}                      the connection was lost (reconnects, resumes)

/** Exported for the tests: the exact text `node -e` runs. */
export const DAEMON_HELPER_JS = String.raw`'use strict'
const net = require('node:net')
const fs = require('node:fs')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/
const out = o => {
  try {
    process.stdout.write(JSON.stringify(o) + '\n')
  } catch {
    process.exit(0)
  }
}
process.stdout.on('error', () => process.exit(0))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const args = process.argv.slice(1)

class LinkError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// One connection, requests matched by id; a line no request waits for is a push.
const open = path =>
  new Promise((resolve, reject) => {
    const sock = net.connect(path)
    sock.setEncoding('utf8')
    let buf = ''
    let up = false
    let n = 0
    const pending = new Map()
    const pushes = []
    let pushWaiter
    let closed = false
    const finish = () => {
      closed = true
      for (const p of pending.values()) {
        clearTimeout(p.timer)
        p.reject(new LinkError('closed', 'the daemon closed the connection'))
      }
      pending.clear()
      if (pushWaiter) pushWaiter(null)
      pushWaiter = undefined
    }
    sock.on('error', e => {
      if (!up) reject(new LinkError(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'not_running' : 'error', e.code || 'error'))
    })
    sock.on('close', finish)
    sock.on('data', chunk => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (!msg || typeof msg !== 'object') continue
        let p = typeof msg.id === 'string' ? pending.get(msg.id) : undefined
        let key = msg.id
        // A request the daemon could not parse (an op it does not know) is answered with
        // id "": it is the only request waiting at that moment (one at a time here).
        if (!p && msg.ok === false && msg.id === '' && pending.size === 1) {
          key = [...pending.keys()][0]
          p = pending.get(key)
        }
        if (p) {
          pending.delete(key)
          clearTimeout(p.timer)
          if (msg.ok === true) p.resolve(msg.result)
          else p.reject(new LinkError((msg.error && msg.error.code) || 'internal', (msg.error && msg.error.message) || 'refused'))
          continue
        }
        if (pushWaiter) {
          const w = pushWaiter
          pushWaiter = undefined
          w(msg)
        } else if (pushes.length < 200) pushes.push(msg)
      }
    })
    sock.on('connect', () => {
      up = true
      resolve({
        call(op, a, timeoutMs) {
          if (closed) return Promise.reject(new LinkError('closed', 'the daemon closed the connection'))
          const id = 'cm' + process.pid + '-' + ++n
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(id)
              rej(new LinkError('timeout', 'the daemon did not answer in time'))
            }, timeoutMs)
            pending.set(id, { resolve: res, reject: rej, timer })
            sock.write(JSON.stringify(Object.assign({}, a, { id, op })) + '\n')
          })
        },
        nextPush() {
          if (pushes.length) return Promise.resolve(pushes.shift())
          if (closed) return Promise.resolve(null)
          return new Promise(r => {
            pushWaiter = r
          })
        },
        close() {
          sock.destroy()
        },
      })
    })
  })

const started = r => {
  const o = { t: 'started', sessionId: r.sessionId }
  for (const k of ['agent', 'label', 'folder', 'repo', 'branch']) if (typeof r[k] === 'string') o[k] = r[k]
  return o
}

const itemsOf = r => (r && Array.isArray(r.items) ? r.items : [])

// Everything waiting for this session, until the inbox is empty.
const drain = async (l, session) => {
  for (let i = 0; i < 20; i++) {
    const items = itemsOf(await l.call('inbox', { session, max: 10, wait: 0 }, 60000))
    if (items.length === 0) return
    out({ t: 'items', items })
  }
}

const watch = async (path, cwd, as) => {
  const parent = process.ppid
  // The host went away without killing this child: leave (the daemon then ends the session).
  setInterval(() => {
    if (process.ppid !== parent) process.exit(0)
  }, 5000).unref()
  let last
  let delay = 1000
  const spawned = process.env.TALKIF_AGENTS_SESSION
  for (;;) {
    let l
    try {
      l = await open(path)
    } catch (e) {
      out({ t: 'down', message: e.message })
      await sleep(delay)
      delay = Math.min(30000, delay * 2)
      continue
    }
    try {
      const base = { cwd, client: 'mcp', pid: parent }
      if (as) base.as = as
      const tries = []
      if (last) tries.push(Object.assign({}, base, { resume: last.sessionId }, last.label ? { label: last.label } : {}))
      else if (spawned && UUID.test(spawned)) tries.push(Object.assign({}, base, { spawnSession: spawned }))
      tries.push(base)
      let r
      let err
      for (const a of tries) {
        try {
          r = await l.call('session_start', a, 30000)
          break
        } catch (e) {
          err = e
          if (e.code === 'closed') throw e
        }
      }
      if (!r || typeof r.sessionId !== 'string' || !UUID.test(r.sessionId)) {
        out({ t: 'error', code: (err && err.code) || 'internal', message: (err && err.message) || 'no session' })
        l.close()
        await sleep(30000)
        continue
      }
      last = { sessionId: r.sessionId, label: typeof r.label === 'string' && LABEL.test(r.label) ? r.label : undefined }
      delay = 1000
      out(started(r))
      const session = r.sessionId
      let push = true
      try {
        const s = await l.call('subscribe', { session }, 10000)
        const first = itemsOf(s)
        if (first.length) out({ t: 'items', items: first })
      } catch (e) {
        if (e.code === 'closed') throw e
        push = false
      }
      out({ t: 'mode', mode: push ? 'push' : 'poll' })
      if (push) {
        await drain(l, session)
        for (;;) {
          const m = await l.nextPush()
          if (m === null) break
          // Items in the push are used as they are; any other push is a doorbell.
          if (Array.isArray(m.items)) {
            if (m.items.length) out({ t: 'items', items: m.items })
          } else if (m.item && typeof m.item === 'object') out({ t: 'items', items: [m.item] })
          else await drain(l, session)
        }
      } else {
        for (;;) {
          const items = itemsOf(await l.call('inbox', { session, max: 10, wait: 20 }, 60000))
          if (items.length) out({ t: 'items', items })
        }
      }
    } catch {
      // Lost or failed: reconnect below and resume the same session.
    }
    l.close()
    out({ t: 'closed' })
    await sleep(delay)
    delay = Math.min(30000, delay * 2)
  }
}

const once = async path => {
  let req
  try {
    req = JSON.parse(fs.readFileSync(0, 'utf8'))
  } catch {
    out({ ok: false, error: { code: 'bad_request', message: 'no request on stdin' } })
    return
  }
  try {
    const l = await open(path)
    try {
      const result = await l.call(String(req.op), req.args && typeof req.args === 'object' ? req.args : {}, 60000)
      out({ ok: true, result })
    } finally {
      l.close()
    }
  } catch (e) {
    out({ ok: false, error: { code: e.code || 'internal', message: e.message || 'failed' } })
  }
}

if (args[0] === 'watch' && args[1] && args[2]) watch(args[1], args[2], process.env.TALKIF_AGENT || args[3] || undefined)
else if (args[0] === 'call' && args[1]) once(args[1]).then(() => process.exit(0))
else {
  out({ ok: false, error: { code: 'bad_request', message: 'usage: watch <socket> <cwd> [agent] | call <socket>' } })
  process.exit(2)
}
`
