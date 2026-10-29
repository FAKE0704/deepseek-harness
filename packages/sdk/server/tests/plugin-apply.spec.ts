import { MESSAGES_RESPONSE } from './messages-response.ts'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as jsonrpc from '../src/index.ts'

/**
 * Mount the real namespace plugin with in-memory stdio and exit hooks. Covers
 * the full transport/server path, response-before-exit shutdown exactly once,
 * and bare-fiber disposal without process exit.
 */

/** One ordered frame, write completion, or exit observation. */
type WireEvent =
  | { kind: 'frame'; frame: Record<string, unknown> }
  | { kind: 'write-complete'; ids: (string | number)[] }
  | { kind: 'root-disposed' }
  | { kind: 'exit'; code: number }

interface ApplyHarness {
  ctx: Context
  /** The transport input stream, for driving an EOF. */
  input: PassThrough
  /** The plugin fiber used by the bare-dispose case. */
  fiber: Awaited<ReturnType<Context['plugin']>>
  /** Frames, write completions, and exits in observation order. */
  events: WireEvent[]
  outputErrors: Error[]
  send(frame: Record<string, unknown>): void
  sendRaw(text: string): void
  frames(): Record<string, unknown>[]
  exits(): number[]
  waitForFrame(predicate: (frame: Record<string, unknown>) => boolean, description: string): Promise<Record<string, unknown>>
  dispose(): Promise<void>
}

/** Adapter whose route registration is the delayed Loader entry's readiness fact. */
class DelayedAdapter extends LlmAdapter {
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('not exercised')
  }
}

/** Poll asynchronous output for up to five seconds. */
async function waitFor<T>(get: () => T | undefined, description: string): Promise<T> {
  const deadline = Date.now() + 5000
  for (;;) {
    const value = get()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** Drain asynchronous work before a negative assertion. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 25))
}

/** Mount the real plugin on a minimal harness with in-memory stdio and exit. */
async function mountPlugin(
  storageDir: string,
  options: {
    writeDelayMs?: number
    failFlush?: boolean
    eofExitGraceMs?: number
    beforeServer?: (ctx: Context) => Promise<void> | void
  } = {},
): Promise<ApplyHarness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root: storageDir })
  await new Promise(resolve => setTimeout(resolve, 50))
  await options.beforeServer?.(ctx)

  const input = new PassThrough()
  const events: WireEvent[] = []
  const outputErrors: Error[] = []
  let pendingOutput = ''
  // Record frame admission separately from write completion so delayed output
  // tests the flush barrier.
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const ids: (string | number)[] = []
      pendingOutput += chunk.toString('utf8')
      for (;;) {
        const newline = pendingOutput.indexOf('\n')
        if (newline < 0) break
        const line = pendingOutput.slice(0, newline).trim()
        pendingOutput = pendingOutput.slice(newline + 1)
        if (line) {
          const frame = JSON.parse(line) as Record<string, unknown>
          events.push({ kind: 'frame', frame })
          if (typeof frame.id === 'string' || typeof frame.id === 'number') ids.push(frame.id)
        }
      }
      const complete = (): void => {
        if (options.failFlush === true && chunk.length === 0) {
          callback(new Error('flush callback failed'))
          return
        }
        events.push({ kind: 'write-complete', ids })
        callback()
      }
      if ((options.writeDelayMs ?? 0) > 0) setTimeout(complete, options.writeDelayMs)
      else complete()
    },
  })
  output.on('error', (error: Error) => { outputErrors.push(error) })
  const exit = (code: number): void => { events.push({ kind: 'exit', code }) }

  ctx.effect(() => () => { events.push({ kind: 'root-disposed' }) }, 'jsonrpc test root-disposal witness')
  const fiber = await ctx.plugin(jsonrpc, {
    input,
    output,
    exit,
    ...(options.eofExitGraceMs === undefined ? {} : { eofExitGraceMs: options.eofExitGraceMs }),
  })

  const frames = (): Record<string, unknown>[] =>
    events.flatMap(event => event.kind === 'frame' ? [event.frame] : [])
  return {
    ctx,
    fiber,
    input,
    events,
    outputErrors,
    send: (frame) => { input.write(`${JSON.stringify(frame)}\n`) },
    sendRaw: (text) => { input.write(text) },
    frames,
    exits: () => events.flatMap(event => event.kind === 'exit' ? [event.code] : []),
    waitForFrame: (predicate, description) => waitFor(() => frames().find(predicate), description),
    dispose: async () => { await ctx.fiber.dispose() },
  }
}

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  vi.unstubAllEnvs()
})

/** Keyless SSE endpoint for completing a prompt turn. */
async function mockCompletionServer(): Promise<{ url: string; requests: unknown[] }> {
  const requests: unknown[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(MESSAGES_RESPONSE)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, requests }
}

describe('dsh-sdk-jsonrpc-server plugin apply', () => {
  it('serves initialize over the injected stdio pair', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-init-'))
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    const harness = await mountPlugin(storageDir)
    try {
      harness.send({ jsonrpc: '2.0', id: 'init-1', method: 'initialize', params: { cwd: storageDir, provider: 'deepseek-official', model: 'apply-model' } })

      const response = await harness.waitForFrame(frame => frame.id === 'init-1', 'initialize response')
      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 'init-1',
        result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } },
      })
      expect(harness.exits()).toEqual([])
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('waits for Loader-owned adapter registration before initialize', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-readiness-'))
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    let markStarted!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const ready = new Promise<void>((resolve) => { release = resolve })
    let delayedEntry: Promise<string> | undefined
    const harness = await mountPlugin(storageDir, {
      beforeServer: async (ctx) => {
        await ctx.plugin(Loader)
        ctx.loader.builtins['delayed-readiness'] = {
          inject: ['llm'],
          async apply(entryCtx: Context) {
            markStarted()
            await ready
            entryCtx.llm.registerAdapter(['delayed-private'], new DelayedAdapter())
          },
        }
        delayedEntry = ctx.loader.create({ name: 'cordis:delayed-readiness' })
        await started
      },
    })
    try {
      const initialize = {
        jsonrpc: '2.0',
        id: 'init-delayed',
        method: 'initialize',
        params: { cwd: storageDir, provider: 'delayed-private', model: 'apply-model' },
      }
      const probe = { jsonrpc: '2.0', id: 'probe-during-delay', method: 'nope/unknown' }
      harness.sendRaw(`${JSON.stringify(initialize)}\n${JSON.stringify(probe)}\n`)

      // The transport processes independent requests concurrently. Receiving
      // this later probe proves the preceding initialize handler has reached
      // its Loader wait, without relying on a scheduler delay.
      await harness.waitForFrame(frame => frame.id === 'probe-during-delay', 'probe while initialize waits')
      expect(harness.frames().some(frame => frame.id === 'init-delayed')).toBe(false)

      release()
      await delayedEntry
      const response = await harness.waitForFrame(frame => frame.id === 'init-delayed', 'initialize response after Loader settlement')
      expect(response).toMatchObject({
        id: 'init-delayed',
        result: { serverInfo: { name: 'deepseek-harness-sdk-runtime' } },
      })
      expect(harness.ctx.llm.listProviders()).toContainEqual({ id: 'delayed-private', name: 'delayed-private' })
    } finally {
      release()
      await Promise.allSettled(delayedEntry === undefined ? [] : [delayedEntry])
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('drives a session/prompt turn end-to-end and forwards session notifications as output frames', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-prompt-'))
    const llmServer = await mockCompletionServer()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', llmServer.url)
    const harness = await mountPlugin(storageDir)
    try {
      harness.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { cwd: storageDir, provider: 'deepseek-official', model: 'dsagent-model' } })
      await harness.waitForFrame(frame => frame.id === 1, 'initialize response')

      harness.send({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: { sessionId: 'main', contentBlocks: [{ type: 'text', text: 'fix it' }] },
      })
      const response = await harness.waitForFrame(frame => frame.id === 2, 'prompt response')
      expect((response.result as { messageId?: unknown }).messageId).toBeTypeOf('string')
      await harness.waitForFrame(
        frame => frame.method === 'session.status'
          && (frame.params as { status?: string } | undefined)?.status === 'idle',
        'idle session status',
      )

      expect(llmServer.requests).toHaveLength(1)
      const body = llmServer.requests[0] as { model: string; messages: { role: string }[] }
      expect(body.model).toBe('dsagent-model')
      expect(body.messages.at(-1)?.role).toBe('user')

      // Notifications use the same transport and arrive as id-less frames.
      const notifications = harness.frames().filter(frame => frame.id === undefined)
      expect(notifications.some(frame => frame.method === 'session.event')).toBe(true)
      expect(notifications.findLast(frame => frame.method === 'session.status')).toMatchObject({
        jsonrpc: '2.0',
        params: { sessionId: 'main', status: 'idle' },
      })
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('answers shutdown before exiting 0 exactly once, even against a racing second shutdown', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-shutdown-'))
    const harness = await mountPlugin(storageDir, { writeDelayMs: 10 })
    try {
      // One chunk makes the two deferred exit callbacks race.
      const first = { jsonrpc: '2.0', id: 'sd-1', method: 'shutdown' }
      const second = { jsonrpc: '2.0', id: 'sd-2', method: 'shutdown' }
      harness.sendRaw(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`)

      await waitFor(() => harness.exits().length > 0 ? true : undefined, 'exit recorder call')
      expect(harness.exits()).toEqual([0])

      // Both response writes and the flush barrier complete before exit.
      const exitIndex = harness.events.findIndex(event => event.kind === 'exit')
      const firstResponse = harness.events.findIndex(event => event.kind === 'frame' && event.frame.id === 'sd-1')
      const secondResponse = harness.events.findIndex(event => event.kind === 'frame' && event.frame.id === 'sd-2')
      const firstComplete = harness.events.findIndex(event => event.kind === 'write-complete' && event.ids.includes('sd-1'))
      const secondComplete = harness.events.findIndex(event => event.kind === 'write-complete' && event.ids.includes('sd-2'))
      const flushComplete = harness.events.findIndex(event => event.kind === 'write-complete' && event.ids.length === 0)
      const rootDisposed = harness.events.findIndex(event => event.kind === 'root-disposed')
      expect(firstResponse).toBeGreaterThanOrEqual(0)
      expect(secondResponse).toBeGreaterThanOrEqual(0)
      expect(firstComplete).toBeGreaterThan(firstResponse)
      expect(secondComplete).toBeGreaterThan(secondResponse)
      expect(flushComplete).toBeGreaterThan(firstComplete)
      expect(flushComplete).toBeGreaterThan(secondComplete)
      expect(rootDisposed).toBeGreaterThan(flushComplete)
      expect(exitIndex).toBeGreaterThan(rootDisposed)

      await settle()
      expect(harness.exits()).toEqual([0])
      expect(harness.events.filter(event => event.kind === 'root-disposed')).toHaveLength(1)

      const before = harness.frames().length
      harness.send({ jsonrpc: '2.0', id: 'after-exit', method: 'initialize', params: { cwd: storageDir, provider: 'deepseek-official', model: 'x' } })
      await settle()
      expect(harness.frames().length).toBe(before)
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('still disposes and exits once when the flush callback fails', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-flush-failure-'))
    const harness = await mountPlugin(storageDir, { failFlush: true })
    try {
      harness.send({ jsonrpc: '2.0', id: 'sd-fail', method: 'shutdown' })

      await waitFor(() => harness.exits().length > 0 ? true : undefined, 'exit after flush failure')
      await settle()
      expect(harness.exits()).toEqual([0])
      expect(harness.events.filter(event => event.kind === 'root-disposed')).toHaveLength(1)
      expect(harness.outputErrors.map(error => error.message)).toEqual(['flush callback failed'])

      const before = harness.frames().length
      harness.send({ jsonrpc: '2.0', id: 'after-flush-failure', method: 'initialize', params: { cwd: storageDir, provider: 'deepseek-official', model: 'x' } })
      await settle()
      expect(harness.frames().length).toBe(before)
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('stops serving on a bare fiber dispose (HMR-style unload) without calling exit', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-dispose-'))
    const harness = await mountPlugin(storageDir)
    try {
      // Prove the handler-rejection path is live before disposal.
      harness.send({ jsonrpc: '2.0', id: 'probe-1', method: 'nope/unknown' })
      const error = await harness.waitForFrame(frame => frame.id === 'probe-1', 'error response for unknown method')
      expect(error.error).toMatchObject({
        code: -32603,
        message: 'unknown DeepSeek Harness SDK runtime method: nope/unknown',
      })

      await harness.fiber.dispose()
      expect(harness.events.some(event => event.kind === 'root-disposed')).toBe(false)

      const before = harness.frames().length
      harness.send({ jsonrpc: '2.0', id: 'probe-2', method: 'initialize', params: { cwd: storageDir, provider: 'deepseek-official', model: 'x' } })
      await settle()
      expect(harness.frames().length).toBe(before)
      expect(harness.exits()).toEqual([])
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })
})

/** Clear the EOF grace env for one test body, restoring it afterwards. */
async function withoutEofEnv(run: () => Promise<void>): Promise<void> {
  const previous = process.env.DSH_SDK_EOF_EXIT_GRACE_MS
  delete process.env.DSH_SDK_EOF_EXIT_GRACE_MS
  try {
    await run()
  } finally {
    if (previous !== undefined) process.env.DSH_SDK_EOF_EXIT_GRACE_MS = previous
  }
}

/** Release the test worker from a plugin mount whose disposal is deliberately hung. */
async function abandon(harness: ApplyHarness, storageDir: string): Promise<void> {
  await Promise.race([harness.dispose(), new Promise(resolve => setTimeout(resolve, 500))])
  await rm(storageDir, { recursive: true, force: true })
}

describe('dsh-sdk-jsonrpc-server EOF bounded self-exit', () => {
  it('merges a shutdown RPC landing inside the grace window into exactly one dispose and exit', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-eof-merge-'))
    const harness = await mountPlugin(storageDir, { eofExitGraceMs: 80 })
    try {
      // The RPC task starts first; the EOF timer must join it, not re-run it.
      harness.send({ jsonrpc: '2.0', id: 'sd-eof-merge', method: 'shutdown' })
      harness.input.end()
      await waitFor(() => harness.exits().length > 0 ? true : undefined, 'merged exit')
      expect(harness.exits()).toEqual([0])
      expect(harness.events.filter(event => event.kind === 'root-disposed')).toHaveLength(1)
      await settle()
      expect(harness.exits()).toEqual([0])
      expect(harness.events.filter(event => event.kind === 'root-disposed')).toHaveLength(1)
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('exits through a shutdown RPC that beats a long grace window, with the later timer a no-op', { timeout: 10_000 }, async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-eof-beat-'))
    const harness = await mountPlugin(storageDir, { eofExitGraceMs: 2000 })
    try {
      harness.send({ jsonrpc: '2.0', id: 'sd-eof-beat', method: 'shutdown' })
      harness.input.end()
      // Well inside the 2000ms grace: the RPC path must win immediately.
      const deadline = Date.now() + 1200
      while (harness.exits().length === 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(harness.exits()).toEqual([0])
      expect(harness.events.filter(event => event.kind === 'root-disposed')).toHaveLength(1)
      // The grace timer fires afterwards and must be a no-op.
      await new Promise(resolve => setTimeout(resolve, 2200))
      expect(harness.exits()).toEqual([0])
      expect(harness.events.filter(event => event.kind === 'root-disposed')).toHaveLength(1)
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('keeps EOF a no-op when the grace is disabled via config', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-eoff-config-'))
    const harness = await mountPlugin(storageDir, { eofExitGraceMs: -1 })
    try {
      harness.input.end()
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(harness.exits()).toEqual([])
      expect(harness.events.some(event => event.kind === 'root-disposed')).toBe(false)
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('keeps EOF a no-op when the grace is disabled via the env off value', async () => {
    vi.stubEnv('DSH_SDK_EOF_EXIT_GRACE_MS', 'off')
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-eoff-env-'))
    const harness = await mountPlugin(storageDir)
    try {
      harness.input.end()
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(harness.exits()).toEqual([])
      expect(harness.events.some(event => event.kind === 'root-disposed')).toBe(false)
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('exits through the full dispose path on a zero grace', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-eof-zero-'))
    const harness = await mountPlugin(storageDir, { eofExitGraceMs: 0 })
    try {
      harness.input.end()
      await waitFor(() => harness.exits().length > 0 ? true : undefined, 'zero-grace exit')
      expect(harness.exits()).toEqual([0])
      expect(harness.events.filter(event => event.kind === 'root-disposed')).toHaveLength(1)
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('detaches the EOF listener and cancels the armed timer on effect disposal', { timeout: 10_000 }, async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-eof-detach-'))
    const harness = await mountPlugin(storageDir, { eofExitGraceMs: 60 })
    try {
      // EOF then immediate disposal: the armed timer must be cancelled.
      harness.input.end()
      await harness.fiber.dispose()
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(harness.exits()).toEqual([])
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }

    const laterDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-eof-detach2-'))
    const later = await mountPlugin(laterDir, { eofExitGraceMs: 60 })
    try {
      // Disposal without an EOF detaches the listener: a later EOF is inert.
      await later.fiber.dispose()
      later.input.end()
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(later.exits()).toEqual([])
    } finally {
      await later.dispose()
      await rm(laterDir, { recursive: true, force: true })
    }
  })

  it('defaults an injected test input to disabled', async () => {
    await withoutEofEnv(async () => {
      const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-eof-default-'))
      const harness = await mountPlugin(storageDir)
      try {
        harness.input.end()
        await new Promise(resolve => setTimeout(resolve, 100))
        expect(harness.exits()).toEqual([])
        expect(harness.events.some(event => event.kind === 'root-disposed')).toBe(false)
      } finally {
        await harness.dispose()
        await rm(storageDir, { recursive: true, force: true })
      }
    })
  })

  it('keeps the transport drain-then-stop semantics unchanged across EOF', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-eof-drain-'))
    const harness = await mountPlugin(storageDir, { eofExitGraceMs: 60 })
    try {
      // The complete line rides the same chunk batch as the EOF: drain still lands it.
      harness.send({ jsonrpc: '2.0', id: 'eof-drain', method: 'nope/unknown' })
      harness.input.end()
      const drained = await harness.waitForFrame(frame => frame.id === 'eof-drain', 'response drained before EOF')
      expect(drained.error).toMatchObject({ code: -32603 })
      await waitFor(() => harness.exits().length > 0 ? true : undefined, 'exit after grace')
      expect(harness.exits()).toEqual([0])
      // Frames after the EOF never produce responses.
      const before = harness.frames().length
      harness.send({ jsonrpc: '2.0', id: 'post-eof', method: 'nope/unknown' })
      await settle()
      expect(harness.frames().length).toBe(before)
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('swallows a synchronously throwing stderr write on the suicide path', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw new Error('dead pipe')
    })
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-eof-throw-'))
    const harness = await mountPlugin(storageDir, { eofExitGraceMs: 40 })
    try {
      harness.input.end()
      await waitFor(() => harness.exits().length > 0 ? true : undefined, 'exit despite stderr throw')
      expect(harness.exits()).toEqual([0])
    } finally {
      spy.mockRestore()
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('absorbs an asynchronous stderr EPIPE on the suicide path and still notifies once', { timeout: 10_000 }, async () => {
    const stderrWrites: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(function (this: NodeJS.WriteStream, chunk: unknown, callback?: (error?: Error | null) => void) {
      stderrWrites.push(String(chunk))
      queueMicrotask(() => {
        this.emit('error', new Error('EPIPE'))
        callback?.(new Error('EPIPE'))
      })
      return true
    } as typeof process.stderr.write)
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-eof-epipe-'))
    const harness = await mountPlugin(storageDir, { eofExitGraceMs: 40 })
    try {
      harness.input.end()
      await waitFor(() => harness.exits().length > 0 ? true : undefined, 'exit despite EPIPE')
      expect(harness.exits()).toEqual([0])
      expect(stderrWrites).toEqual(['[sdk-jsonrpc-server] input closed; exiting in 40ms\n'])
    } finally {
      spy.mockRestore()
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('warns and falls through the tiers on invalid grace values', async () => {
    const stderrWrites: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown, callback?: (error?: Error | null) => void) => {
      stderrWrites.push(String(chunk))
      callback?.()
      return true
    }) as typeof process.stderr.write)
    try {
      // Config tier invalid (NaN): warns, falls to the default (injected input = disabled).
      const configDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-eof-nan-'))
      const configHarness = await mountPlugin(configDir, { eofExitGraceMs: Number.NaN })
      try {
        configHarness.input.end()
        await new Promise(resolve => setTimeout(resolve, 100))
        expect(configHarness.exits()).toEqual([])
        expect(stderrWrites.join('')).toContain('invalid DSH_SDK_EOF_EXIT_GRACE_MS value NaN; ignoring')
      } finally {
        await configHarness.dispose()
        await rm(configDir, { recursive: true, force: true })
      }

      // Env tier invalid string: warns, falls to the default (disabled).
      vi.stubEnv('DSH_SDK_EOF_EXIT_GRACE_MS', 'abc')
      const envDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-eof-abc-'))
      const envHarness = await mountPlugin(envDir)
      try {
        envHarness.input.end()
        await new Promise(resolve => setTimeout(resolve, 100))
        expect(envHarness.exits()).toEqual([])
        expect(stderrWrites.join('')).toContain('invalid DSH_SDK_EOF_EXIT_GRACE_MS value "abc"; ignoring')
      } finally {
        await envHarness.dispose()
        await rm(envDir, { recursive: true, force: true })
      }

      // Env tier negative: disabled without a warning.
      vi.stubEnv('DSH_SDK_EOF_EXIT_GRACE_MS', '-3')
      const negativeDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-eof-neg-'))
      const negativeHarness = await mountPlugin(negativeDir)
      try {
        negativeHarness.input.end()
        await new Promise(resolve => setTimeout(resolve, 100))
        expect(negativeHarness.exits()).toEqual([])
        expect(stderrWrites).toHaveLength(2)
      } finally {
        await negativeHarness.dispose()
        await rm(negativeDir, { recursive: true, force: true })
      }
    } finally {
      spy.mockRestore()
    }
  })

  it('applies the env numeric value in milliseconds, including zero', async () => {
    vi.stubEnv('DSH_SDK_EOF_EXIT_GRACE_MS', '30')
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-eof-env30-'))
    const harness = await mountPlugin(storageDir)
    try {
      harness.input.end()
      await waitFor(() => harness.exits().length > 0 ? true : undefined, 'env-grace exit')
      expect(harness.exits()).toEqual([0])
      expect(harness.events.filter(event => event.kind === 'root-disposed')).toHaveLength(1)
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }

    vi.stubEnv('DSH_SDK_EOF_EXIT_GRACE_MS', '0')
    const zeroDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-eof-env0-'))
    const zeroHarness = await mountPlugin(zeroDir)
    try {
      zeroHarness.input.end()
      await waitFor(() => zeroHarness.exits().length > 0 ? true : undefined, 'env-zero exit')
      expect(zeroHarness.exits()).toEqual([0])
    } finally {
      await zeroHarness.dispose()
      await rm(zeroDir, { recursive: true, force: true })
    }
  })

  it('resolves the production stdin shape to the five-second default', async () => {
    // No input override: resolution must fall through to the default grace.
    // It arms only on a real EOF, which the worker's idle stdin never produces.
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-eof-stdin-'))
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(JsonlSessionPersistence, { root: storageDir })
    await new Promise(resolve => setTimeout(resolve, 50))
    const exits: number[] = []
    const fiber = await ctx.plugin(jsonrpc, {
      output: new Writable({ write: (_chunk, _encoding, callback) => { callback() } }),
      exit: (code) => { exits.push(code) },
    })
    try {
      await settle()
      expect(exits).toEqual([])
    } finally {
      await fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('prefers the launch-environment snapshot over the inherited environment', async () => {
    vi.stubEnv('DSH_SDK_EOF_EXIT_GRACE_MS', 'off')
    // The snapshot layer says 50ms; only a snapshot-preferring read exits.
    const snapshot = createLaunchEnvironmentSnapshot([{
      source: 'process',
      values: { ...process.env, DSH_SDK_EOF_EXIT_GRACE_MS: '50' },
    }])
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-eof-snap-'))
    const harness = await mountPlugin(storageDir, {
      beforeServer: (ctx) => { ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, snapshot) },
    })
    try {
      harness.input.end()
      await waitFor(() => harness.exits().length > 0 ? true : undefined, 'snapshot-grace exit')
      expect(harness.exits()).toEqual([0])
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('forces the exit when the flush barrier hangs past the flush deadline', { timeout: 15_000 }, async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-eof-flushdl-'))
    const harness = await mountPlugin(storageDir, { eofExitGraceMs: 30, writeDelayMs: 100_000 })
    try {
      harness.input.end()
      await waitFor(() => harness.exits().length > 0 ? true : undefined, 'flush-deadline exit')
      expect(harness.exits()).toEqual([0])
      // The dispose stage never ran: the deadline cut in ahead of it.
      expect(harness.events.some(event => event.kind === 'root-disposed')).toBe(false)
    } finally {
      await abandon(harness, storageDir)
    }
  })

  it('forces the exit when root disposal hangs past the dispose deadline', { timeout: 30_000 }, async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-eof-disposedl-'))
    const harness = await mountPlugin(storageDir, {
      eofExitGraceMs: 30,
      beforeServer: (ctx) => {
        ctx.effect(() => () => new Promise<void>(() => { /* deliberately hung disposal */ }), 'hung root disposal witness')
      },
    })
    try {
      harness.input.end()
      const startedAt = Date.now()
      const deadline = startedAt + 14_000
      while (harness.exits().length === 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(harness.exits().length).toBeGreaterThan(0)
      // The flush stage settles in milliseconds; only the 10s dispose deadline explains this exit.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(9000)
      expect(harness.exits()).toEqual([0])
      // The dispose stage did start (its synchronous witness ran); the deadline
      // cut the process off while its hung sibling was still pending.
      expect(harness.events.some(event => event.kind === 'root-disposed')).toBe(true)
    } finally {
      await abandon(harness, storageDir)
    }
  })
})
