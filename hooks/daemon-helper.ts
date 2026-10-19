// The child process that holds this session's connection to the local Agent Bridge daemon
// (talkif-agents). The plugin cannot open a Unix socket that speaks newline JSON (its
// network is fetch only), so it runs this script with `node -e` and reads its stdout.
//
//   watch <socket> <cwd> [<agent>|-] [writes]
//                                    on one long-lived connection: attach to the session
//                                    this window's MCP server registered (session_attach,
//                                    by the window's tool pid; one window, one session), or,
//                                    when the window runs none, register one of its own
//                                    (session_start, client "mcp", as $TALKIF_AGENT, else
//                                    <agent>). Then wait for its items: the `subscribe` op
//                                    (without `writes`: write jobs stay for check_inbox) when
//                                    the daemon has it, else a long-poll of `inbox`. One JSON
//                                    line per event on stdout. An own session ends when this
//                                    process (and so the connection) goes away; an attached
//                                    one lives with its MCP server.
//                                    Delivery confirmation (daemon ≥ 0.5): subscribed with
//                                    confirm, each pushed item has a pushId; the item counts as
//                                    delivered only once the plugin wrote its delivery key to
//                                    the handed log (after it handed the item to the window). This
//                                    process then sends `delivered` for it; an item whose
//                                    key is already in the log is confirmed without being
//                                    shown again (exactly once, also across restarts).
//   call <socket>                    one request read from stdin as {op, args}; one JSON
//                                    line {ok, result | error} on stdout.
//
// It opens no network connection, reads no key or credential file, and never puts peer
// text or answers on a command line (stdin and the socket only).
//
// stdout events of `watch`:
//   {"t":"started", sessionId, attached, handedLog, agent?, label?, folder?, repo?, branch?}
//   {"t":"mode", mode: "push" | "poll"}
//   {"t":"items", items: [...]}         daemon inbox entries, as the daemon returns them
//   {"t":"error", code, message}        session_start refused (retried after 30 s)
//   {"t":"down", message}               no daemon listens (retried with backoff)
//   {"t":"closed"}                      the connection was lost (reconnects, resumes)

/** Exported for the tests: the exact text `node -e` runs. */
export const DAEMON_HELPER_JS = String.raw`'use strict'
const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
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

// The handed log (one "<ms> <delivery key>" per line, 0600): what this session's window already has.
const HANDED_KEEP_MS = 24 * 3600 * 1000
const MESSAGE_ID = /^[A-Za-z0-9:._-]{1,128}$/
const DELIVERY_KEY = /^[A-Za-z0-9:#._-]{1,256}$/
const RECEIVED_AT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/
// The key of one pushed item in the handed log (the plugin's deliveryKeyOf, same rule): a board
// job comes once per claim, and a new claim of the same job is a new item with its own
// receivedAt, so a job is keyed by messageId, taskId and receivedAt; anything else by messageId.
const keyOf = item => {
  if (!item || typeof item !== 'object' || typeof item.messageId !== 'string' || !MESSAGE_ID.test(item.messageId)) return undefined
  if (item.job === true && typeof item.taskId === 'string' && UUID.test(item.taskId) && typeof item.receivedAt === 'string' && RECEIVED_AT.test(item.receivedAt)) {
    return item.messageId + '#job:' + item.taskId + ':' + item.receivedAt
  }
  return item.messageId
}
const handedLogOf = session => path.join(os.homedir(), '.config', 'talkif', 'agent', 'handed-' + session + '.log')

// What the windows of this computer already have: this session's log, and the logs of the
// sessions before it (an item moved to a new session after a restart is not shown twice).
class Handed {
  constructor(file) {
    this.file = file
    this.ids = new Set()
    this.offset = 0
    const keep = []
    const now = Date.now()
    const dir = path.dirname(file)
    let names = []
    try {
      names = fs.readdirSync(dir).filter(n => /^handed-[0-9a-f-]{36}\.log$/.test(n))
    } catch {}
    for (const name of names) {
      const other = path.join(dir, name)
      let fresh = false
      try {
        for (const line of fs.readFileSync(other, 'utf8').split('\n')) {
          const [at, id] = line.split(' ')
          if (!id || !DELIVERY_KEY.test(id) || !(now - Number(at) < HANDED_KEEP_MS)) continue
          fresh = true
          this.ids.add(id)
          if (other === file) keep.push(line)
        }
        // An old session's log with nothing younger than a day is removed.
        if (!fresh && other !== file && now - fs.statSync(other).mtimeMs > HANDED_KEEP_MS) fs.unlinkSync(other)
      } catch {}
    }
    // Old entries go at start; the file stays owner-only.
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(file + '.tmp', keep.length ? keep.join('\n') + '\n' : '', { mode: 0o600 })
      fs.renameSync(file + '.tmp', file)
      this.offset = fs.statSync(file).size
    } catch {}
  }
  // Lines the plugin appended since the last look.
  refresh() {
    let size
    try {
      size = fs.statSync(this.file).size
    } catch {
      return
    }
    if (size < this.offset) this.offset = 0
    if (size === this.offset) return
    const fd = fs.openSync(this.file, 'r')
    try {
      const buf = Buffer.alloc(size - this.offset)
      fs.readSync(fd, buf, 0, buf.length, this.offset)
      const text = buf.toString('utf8')
      const end = text.lastIndexOf('\n')
      if (end < 0) return
      for (const line of text.slice(0, end).split('\n')) {
        const id = line.split(' ')[1]
        if (id && DELIVERY_KEY.test(id)) this.ids.add(id)
      }
      this.offset += Buffer.byteLength(text.slice(0, end + 1))
    } finally {
      fs.closeSync(fd)
    }
  }
  has(id) {
    return this.ids.has(id)
  }
}

// Pushed items waiting for the window: pushId → { key, at }. Confirmed in batches of ten.
const confirmer = (l, session, handed) => {
  const pending = new Map()
  let timer
  const flush = () => {
    handed.refresh()
    const now = Date.now()
    const done = []
    for (const [pushId, p] of pending) {
      if (handed.has(p.key)) done.push(pushId)
      // The daemon pushes it again with a new pushId after its wait: this one is gone.
      else if (now - p.at > 35000) pending.delete(pushId)
    }
    for (let i = 0; i < done.length; i += 10) {
      const batch = done.slice(i, i + 10)
      for (const id of batch) pending.delete(id)
      l.call('delivered', { session, pushIds: batch }, 10000).catch(() => {})
    }
    if (pending.size === 0) {
      clearInterval(timer)
      timer = undefined
    }
  }
  return {
    // The items to show; those the window already has are confirmed and left out.
    take(items) {
      const show = []
      for (const item of items) {
        const id = keyOf(item)
        const pushId = item && typeof item.pushId === 'string' && UUID.test(item.pushId) ? item.pushId : undefined
        if (!pushId || !id) {
          show.push(item)
          continue
        }
        pending.set(pushId, { key: id, at: Date.now() })
        if (!handed.has(id)) show.push(item)
      }
      if (pending.size && !timer) timer = setInterval(flush, 100)
      if (pending.size) setImmediate(flush)
      return show
    },
    stop() {
      clearInterval(timer)
      timer = undefined
      pending.clear()
    },
  }
}

const started = (r, attached) => {
  const o = { t: 'started', sessionId: r.sessionId, attached, handedLog: handedLogOf(r.sessionId) }
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

// How long a new window waits for its MCP server's session before registering one of its own,
// and how often a window on its own session looks again (the MCP server came up later).
const ATTACH_GRACE_MS = 20000
const RECHECK_MS = 30000
const TICK = Symbol('tick')

const watch = async (path, cwd, as, writeJobs) => {
  const parent = process.ppid
  // The host went away without killing this child: leave (the daemon then ends the session).
  setInterval(() => {
    if (process.ppid !== parent) process.exit(0)
  }, 5000).unref()
  // This window's own session (only while the window runs no talkif MCP server), resumed after a reconnect.
  let own
  // false: the daemon predates session_attach; this window then has a session of its own.
  let attachable = true
  let graceUntil = Date.now() + ATTACH_GRACE_MS
  let delay = 1000
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
    let attached = false
    let confirm
    try {
      // One window, one session: the session the window's MCP server registered, found by this
      // window's tool pid. A job window's own session id is the MCP server's to claim, never this helper's.
      const findWindow = async () => {
        if (!attachable) return undefined
        try {
          return await l.call('session_attach', Object.assign({ pid: parent }, as ? { as } : {}), 10000)
        } catch (e) {
          if (e.code === 'closed') throw e
          if (e.code === 'bad_request' && e.message === 'unknown op') attachable = false
          return undefined
        }
      }
      let r = await findWindow()
      while (!r && attachable && !own && Date.now() < graceUntil) {
        await sleep(1000)
        r = await findWindow()
      }
      if (r && typeof r.sessionId === 'string' && UUID.test(r.sessionId)) {
        attached = true
        own = undefined
      } else {
        const base = { cwd, client: 'mcp', pid: parent }
        if (as) base.as = as
        const tries = []
        if (own) tries.push(Object.assign({}, base, { resume: own.sessionId }, own.label ? { label: own.label } : {}))
        tries.push(base)
        let err
        r = undefined
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
        own = { sessionId: r.sessionId, label: typeof r.label === 'string' && LABEL.test(r.label) ? r.label : undefined }
      }
      delay = 1000
      out(started(r, attached))
      const session = r.sessionId
      let push = true
      const base = Object.assign({ session }, writeJobs ? {} : { writeJobs: false })
      try {
        let s
        try {
          s = await l.call('subscribe', Object.assign({ confirm: true }, base), 10000)
        } catch (e) {
          // A daemon without delivery confirmation: subscribe the old way (items acked when pushed).
          if (e.code !== 'bad_request') throw e
          s = await l.call('subscribe', base, 10000)
        }
        if (s && s.confirm === true) confirm = confirmer(l, session, new Handed(handedLogOf(session)))
        const first = itemsOf(s)
        if (first.length) out({ t: 'items', items: first })
      } catch (e) {
        if (e.code === 'closed') throw e
        push = false
      }
      out({ t: 'mode', mode: push ? 'push' : 'poll' })
      const show = items => (confirm ? confirm.take(items) : items)
      if (push) {
        await drain(l, session)
        let next = l.nextPush()
        for (;;) {
          const m = attached ? await next : await Promise.race([next, sleep(RECHECK_MS).then(() => TICK)])
          if (m === TICK) {
            // The window's MCP server came up after all: move to its session (ours ends with this connection).
            if (await findWindow()) {
              own = undefined
              break
            }
            continue
          }
          next = l.nextPush()
          if (m === null) break
          // The session ended (the MCP server restarted or quit): find it again, from a fresh grace.
          if (m.event === 'end') {
            graceUntil = Date.now() + ATTACH_GRACE_MS
            if (!attached) own = undefined
            break
          }
          // Items in the push are used as they are; any other push is a doorbell.
          if (Array.isArray(m.items)) {
            const items = show(m.items)
            if (items.length) out({ t: 'items', items })
          } else if (m.item && typeof m.item === 'object') {
            const items = show([m.item])
            if (items.length) out({ t: 'items', items })
          } else await drain(l, session)
        }
      } else {
        for (;;) {
          const items = itemsOf(await l.call('inbox', { session, max: 10, wait: 20 }, 60000))
          if (items.length) out({ t: 'items', items })
        }
      }
    } catch {
      // Lost or failed: reconnect below and resume (or attach to) the same session.
      if (attached) graceUntil = Date.now() + ATTACH_GRACE_MS
    }
    // What was pushed and not confirmed comes again on the next connection (new pushIds).
    if (confirm) confirm.stop()
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

if (args[0] === 'watch' && args[1] && args[2]) watch(args[1], args[2], process.env.TALKIF_AGENT || (args[3] && args[3] !== '-' ? args[3] : undefined), args[4] === 'writes')
else if (args[0] === 'call' && args[1]) once(args[1]).then(() => process.exit(0))
else {
  out({ ok: false, error: { code: 'bad_request', message: 'usage: watch <socket> <cwd> [agent] | call <socket>' } })
  process.exit(2)
}
`
