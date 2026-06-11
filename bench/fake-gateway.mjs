#!/usr/bin/env node
// Fake tui_gateway — substituted via HERMES_PYTHON so BOTH UIs spawn THIS
// executable as `$HERMES_PYTHON -m tui_gateway.entry` (argv ignored) and speak
// the identical NDJSON JSON-RPC wire over stdio. ZERO changes to either UI.
//
// Wire contract (mirrors tui_gateway/entry.py + both UI clients):
//   - unsolicited {jsonrpc:"2.0",method:"event",params:{type:"gateway.ready",payload:{skin:{}}}}
//   - events:    {jsonrpc:"2.0",method:"event",params:{type,payload?}}  (no id)
//   - responses: {jsonrpc:"2.0",id,result} for every request, canned per method.
//
// NEVER writes to stderr (both UIs surface gateway stderr lines INTO the UI as
// activity rows / gateway.stderr events, which would perturb the rendered
// transcript). Progress/telemetry goes to HERMES_FAKE_PROGRESS (append-only
// NDJSON file the harness tails).
//
// Env config:
//   HERMES_FAKE_FIXTURE        NDJSON fixture path (from fixture-stream.mjs). Optional.
//   HERMES_FAKE_MODE           burst | paced | load-then-idle   (default burst)
//   HERMES_FAKE_RATE           events/sec for paced mode        (default 30)
//   HERMES_FAKE_START_DELAY_MS delay after session.create reply before streaming (default 1500)
//   HERMES_FAKE_SAMPLE_EVERY   fixture-msg boundary cadence for progress lines (default 100)
//   HERMES_FAKE_PROGRESS       progress NDJSON file path (required for harness runs)
//   HERMES_FAKE_PIDFILE        write own pid here at startup (harness discovers the
//                              gateway pid; a REWRITE by a respawned instance is the
//                              harness's auto-heal detection signal)
//   HERMES_FAKE_DIE_AT         "<msgIndex>:<kill|tool-kill>" — chaos cells: self-SIGKILL
//                              at fixture msg N (kill), or at the first tool.* event
//                              after msg N (tool-kill). Self-termination is deterministic
//                              vs racy external timing. SIGSTOP stays external (a stopped
//                              process can't stop itself usefully).
//   HERMES_FAKE_DIE_FLAG       die-once flag file: created just before the self-kill so
//                              the UI's auto-heal RESPAWN (same env) does not die again
//   HERMES_FAKE_SUBMIT_RESPONSE  "1" → answer prompt.submit with a tiny streamed reply
//                              carrying the marker token "zqxjv" (echo-latency cells)
//
// Modes: burst = write as fast as the pipe accepts (await 'drain' on
// backpressure, so emission tracks UI ingestion within the ~64KB pipe buffer);
// paced = HERMES_FAKE_RATE events/sec; load-then-idle = burst, then sit idle
// (scroll-latency runs drive input afterwards). Exits on stdin EOF (the UIs
// close stdin to stop the gateway) — same lifecycle as the real child.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const FIXTURE = process.env.HERMES_FAKE_FIXTURE || ''
const MODE = process.env.HERMES_FAKE_MODE || 'burst'
const RATE = Math.max(1, Number.parseInt(process.env.HERMES_FAKE_RATE ?? '30', 10) || 30)
const START_DELAY_MS = Number.parseInt(process.env.HERMES_FAKE_START_DELAY_MS ?? '1500', 10) || 1500
const SAMPLE_EVERY = Math.max(1, Number.parseInt(process.env.HERMES_FAKE_SAMPLE_EVERY ?? '100', 10) || 100)
const PROGRESS = process.env.HERMES_FAKE_PROGRESS || ''
const PIDFILE = process.env.HERMES_FAKE_PIDFILE || ''
const DIE_FLAG = process.env.HERMES_FAKE_DIE_FLAG || ''
const SUBMIT_RESPONSE = process.env.HERMES_FAKE_SUBMIT_RESPONSE === '1'

// Chaos self-termination (deterministic, no external kill races). Die-once:
// if the flag file exists a previous instance already died here — this is the
// auto-heal respawn, which must stream to completion.
let dieAtMsgs = null
let dieKind = 'kill'
{
  const m = (process.env.HERMES_FAKE_DIE_AT || '').match(/^(\d+):(kill|tool-kill)$/)
  if (m) {
    dieAtMsgs = Number(m[1])
    dieKind = m[2]
  }
  if (dieAtMsgs !== null && DIE_FLAG && existsSync(DIE_FLAG)) dieAtMsgs = null
}

if (PIDFILE) {
  try {
    writeFileSync(PIDFILE, String(process.pid))
  } catch {
    /* best-effort */
  }
}

const t0 = Date.now()
const progress = obj => {
  if (!PROGRESS) return
  try {
    appendFileSync(PROGRESS, JSON.stringify({ ...obj, t: Date.now() - t0, wall: Date.now() }) + '\n')
  } catch {
    /* progress is best-effort; never crash the wire */
  }
}

// UI gone (pipe closed) → exit quietly like the real child on stdin EOF.
process.stdout.on('error', () => process.exit(0))

const writeFrame = obj => {
  const ok = process.stdout.write(JSON.stringify(obj) + '\n')
  return ok ? null : new Promise(r => process.stdout.once('drain', r))
}
const emitEvent = params => writeFrame({ jsonrpc: '2.0', method: 'event', params })

// ── Canned RPC results (recon'd from both UIs' startup sequences) ──────
const SESSION_ID = 'bench-session-0001'
const INFO = {
  model: 'bench/fake-model',
  version: '0.0.0-bench',
  cwd: process.env.HERMES_CWD || process.cwd(),
  skills: {},
  tools: { core: ['terminal', 'read_file'] },
  usage: { calls: 0, input: 0, output: 0, total: 0 }
}

function resultFor(method, params) {
  switch (method) {
    case 'setup.status':
      return { provider_configured: true }
    case 'session.create':
      return { session_id: SESSION_ID, info: INFO }
    case 'session.resume':
    case 'session.activate':
      return { session_id: SESSION_ID, messages: [], info: INFO }
    case 'session.most_recent':
      return {}
    case 'session.list':
    case 'session.active_list':
      return { sessions: [] }
    case 'config.get':
      if (params && params.key === 'mtime') return { mtime: 1 }
      if (params && params.key === 'full') return { config: { display: {} } }
      return { value: '' }
    case 'commands.catalog':
      return { pairs: [['help', 'show help']], canon: {}, categories: [], sub: {}, skill_count: 0 }
    case 'startup.catalog':
      return { tools: {}, skills: {}, mcp_servers: [] }
    case 'model.options':
      return { providers: [] }
    case 'session.title':
      return { title: 'bench' }
    case 'prompt.submit':
      return { ok: true }
    case 'session.interrupt':
      return { ok: true }
    case 'complete.slash':
    case 'complete.path':
      return { items: [] }
    default:
      return {}
  }
}

// ── Chaos self-kill ────────────────────────────────────────────────────
// Flag first (sync — survives SIGKILL), then a 'dying' progress line (gives
// the harness the precise kill wall-clock), then SIGKILL self.
function dieNow(msgs) {
  if (DIE_FLAG) {
    try {
      writeFileSync(DIE_FLAG, '1')
    } catch {
      /* best-effort */
    }
  }
  progress({ k: 'dying', kind: dieKind, msgs })
  process.kill(process.pid, 'SIGKILL')
}

// ── Fixture streaming ──────────────────────────────────────────────────
let streaming = false
async function streamFixture() {
  if (streaming || !FIXTURE) return
  streaming = true
  const lines = readFileSync(FIXTURE, 'utf8').split('\n')
  let msgs = 0
  let events = 0
  let nextBoundary = SAMPLE_EVERY
  const paced = MODE === 'paced'
  const interval = paced ? 1000 / RATE : 0
  let nextAt = Date.now()
  progress({ k: 'stream_start', mode: MODE })
  for (const raw of lines) {
    if (!raw) continue
    const item = JSON.parse(raw)
    if (item.k === 'e') {
      if (paced) {
        const wait = nextAt - Date.now()
        if (wait > 0) await new Promise(r => setTimeout(r, wait))
        nextAt += interval
      }
      const drained = emitEvent(item.v)
      if (drained) await drained
      events++
      // tool-kill: die exactly as a tool-call event goes over the wire (the
      // first tool.* event after the armed msg index — the UI is left with a
      // started, never-completed tool).
      if (dieAtMsgs !== null && dieKind === 'tool-kill' && msgs >= dieAtMsgs && typeof item.v?.type === 'string' && item.v.type.startsWith('tool.')) {
        dieNow(msgs)
      }
    } else if (item.k === 't') {
      msgs = item.msgs
      if (msgs >= nextBoundary) {
        progress({ k: 'boundary', msgs, events })
        while (nextBoundary <= msgs) nextBoundary += SAMPLE_EVERY
      }
      if (dieAtMsgs !== null && dieKind === 'kill' && msgs >= dieAtMsgs) dieNow(msgs)
    }
    // {"k":"r"} row markers: composer-local rows, nothing on the wire.
  }
  progress({ k: 'done', msgs, events })
}

// ── Main: handshake + request loop ─────────────────────────────────────
progress({ k: 'start', pid: process.pid, mode: MODE, fixture: FIXTURE })
emitEvent({ type: 'gateway.ready', payload: { skin: {} } })

const rl = createInterface({ input: process.stdin })
rl.on('line', line => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (!msg || typeof msg !== 'object' || msg.id === undefined) return
  const method = String(msg.method ?? '')
  progress({ k: 'req', method })
  void writeFrame({ jsonrpc: '2.0', id: msg.id, result: resultFor(method, msg.params) })
  if (method === 'session.create' || method === 'session.resume') {
    setTimeout(() => {
      streamFixture().catch(() => process.exit(1))
    }, START_DELAY_MS)
  }
  // Echo cells: a real (tiny) reply to prompt.submit so input→first-token-paint
  // is measurable. The marker token "zqxjv" never occurs in the lorem fixture.
  if (method === 'prompt.submit' && SUBMIT_RESPONSE) {
    setTimeout(() => {
      progress({ k: 'submit_response' })
      void emitEvent({ type: 'message.start' })
      void emitEvent({ type: 'message.delta', payload: { text: 'Echo probe reply zqxjv — bench token-paint marker.' } })
      void emitEvent({ type: 'message.complete' })
    }, 30)
  }
})
rl.on('close', () => {
  progress({ k: 'eof' })
  process.exit(0)
})
