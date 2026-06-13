/**
 * Background-process panel (P3) — /bg opens it; it lists the polled OS processes
 * with a running count + stop-all affordance, and shows an empty state.
 */
import { describe, expect, test } from 'vitest'

import { parseProcessList } from '../logic/backgroundActivity.ts'
import { createSessionStore } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { captureFrame } from './lib/render.ts'

function appWith(store: ReturnType<typeof createSessionStore>) {
  return () => (
    <ThemeProvider theme={() => store.state.theme}>
      <App store={store} />
    </ThemeProvider>
  )
}

describe('background-process panel (P3)', () => {
  test('parseProcessList maps an agents.list result (snake_case → camel, skips junk)', () => {
    const procs = parseProcessList({
      processes: [
        { session_id: 's1', command: 'vite dev', status: 'running', uptime_seconds: 42 },
        { command: 'no session id — dropped' },
        { session_id: 's2', command: 'claude --bg', status: 'exited', uptime_seconds: 5 }
      ]
    })
    expect(procs).toEqual([
      { sessionId: 's1', command: 'vite dev', status: 'running', uptimeSeconds: 42 },
      { sessionId: 's2', command: 'claude --bg', status: 'exited', uptimeSeconds: 5 }
    ])
  })

  test('the panel lists processes with a running count + stop-all hint', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.setBackgroundProcesses([
      { sessionId: 's1', command: 'vite dev --host 0.0.0.0 --port 3000', status: 'running', uptimeSeconds: 125 },
      { sessionId: 's2', command: 'pytest -x --watch', status: 'running', uptimeSeconds: 8 },
      { sessionId: 's3', command: 'claude-code background job', status: 'exited', uptimeSeconds: 4 }
    ])
    store.openBackgroundPanel()
    const frame = await captureFrame(appWith(store), { until: 'Background processes', width: 110, height: 24 })
    expect(frame).toContain('Background processes · 2 running') // exited one excluded
    expect(frame).toContain('vite dev')
    expect(frame).toContain('pytest')
    expect(frame).toContain('x stop all') // footer affordance
  })

  test('empty state when nothing is running', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.openBackgroundPanel()
    const frame = await captureFrame(appWith(store), { until: 'Background processes', width: 110, height: 24 })
    expect(frame).toContain('No background processes running.')
  })
})
