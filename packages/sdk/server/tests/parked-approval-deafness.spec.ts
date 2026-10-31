import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import ApprovalService, { ApprovalRequestId, type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as jsonrpc from '../src/index.ts'

/**
 * Parked-approval deafness repro (132号 incident): while an approval ask is
 * parked on the external responder, the real sdk-jsonrpc-server plugin stops
 * hearing `session/approval-respond` — not because of any async hang and not
 * because of event-loop congestion, but because the only production close
 * point (`jsonrpc.serve` disposer → `transport.close()`) detaches the input
 * 'data' listener while the process stays alive. Four evidences against the
 * REAL transport, REAL parked approvals, and the REAL plugin:
 *
 * - S1 baseline: a parked ask settles within milliseconds of the respond RPC.
 * - S2 deaf state: after the effect disposer runs, the same RPC produces zero
 *   frames forever — the ask stays parked, the handler never runs, and the
 *   event loop stays healthy. 卡点: transport.ts:87-92.
 * - S3 an unrelated async hang (a never-settling Loader entry parking
 *   `initialize` forever) does NOT deafen the transport.
 * - S4 a 2s synchronous event-loop block delays the response but never
 *   loses it.
 */

interface AppendedEvent {
  type: string
  data: Record<string, unknown>
}

interface Harness {
  ctx: Context
  /** The jsonrpc plugin fiber — disposing it runs the `jsonrpc.serve` disposer. */
  fiber: Awaited<ReturnType<Context['plugin']>>
  /** The transport input stream, for writing request lines. */
  input: PassThrough
  /** The tmpdir session root this harness mounted. */
  storageDir: string
  frames(): Record<string, unknown>[]
  send(frame: Record<string, unknown>): void
  waitForFrame(predicate: (frame: Record<string, unknown>) => boolean, description: string): Promise<Record<string, unknown>>
}

/**
 * A minimal Agent stand-in (the user-approval suite's fixture): the service
 * only reaches `agent.session.append` and indexed log reads, seeded inside an
 * open turn so request()'s enclosure precondition holds.
 */
function fakeAgent(): { agent: Agent; appended: AppendedEvent[] } {
  const appended: AppendedEvent[] = []
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [{ type: 'turn/start' }, { type: 'user/message' }]
  const agent = {
    session: {
      get seq() { return events.length },
      eventAt: (seq: number) => events[seq],
      append: (type: string, data: Record<string, unknown>) => {
        const event = { type, data }
        events.push(event)
        appended.push(event)
        return event
      },
    },
  } as unknown as Agent
  return { agent, appended }
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

/** Mount the real plugin on a minimal harness: real transport, real approval service. */
async function mountHarness(options: { beforeServer?: (ctx: Context, input: PassThrough) => Promise<void> | void } = {}): Promise<Harness> {
  const storageDir = await mkdtemp(join(tmpdir(), 'dsh-deafness-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root: storageDir })
  // The real approval seam: external-responder parking lives on THIS instance.
  await ctx.plugin(ApprovalService)
  await new Promise(resolve => setTimeout(resolve, 50))

  const input = new PassThrough()
  await options.beforeServer?.(ctx, input)

  const frames: Record<string, unknown>[] = []
  let pendingOutput = ''
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      pendingOutput += chunk.toString('utf8')
      for (;;) {
        const newline = pendingOutput.indexOf('\n')
        if (newline < 0) break
        const line = pendingOutput.slice(0, newline).trim()
        pendingOutput = pendingOutput.slice(newline + 1)
        if (line) frames.push(JSON.parse(line) as Record<string, unknown>)
      }
      callback()
    },
  })

  const fiber = await ctx.plugin(jsonrpc, { input, output, exit: () => { /* no RPC path here exits */ } })
  return {
    ctx,
    fiber,
    input,
    storageDir,
    frames: () => frames,
    send: (frame) => { input.write(`${JSON.stringify(frame)}\n`) },
    waitForFrame: (predicate, description) => waitFor(() => frames.find(predicate), description),
  }
}

/** Tear one harness down (dispose + remove its tmpdir); `abandon` caps disposal for mounts that hang on purpose. */
async function cleanupHarness(harness: Harness, options: { abandon?: boolean } = {}): Promise<void> {
  if (options.abandon === true) {
    await Promise.race([harness.ctx.fiber.dispose(), new Promise(resolve => setTimeout(resolve, 500))])
  } else {
    await harness.ctx.fiber.dispose()
  }
  await rm(harness.storageDir, { recursive: true, force: true })
}

interface ParkedAsk {
  asking: Promise<ApprovalOutcome>
  askId: string
  appended: AppendedEvent[]
}

/**
 * Park one real external approval ask on the context's approval service: the
 * plugin's `ctx.inject(['approval'], …)` attached the external responder at
 * mount, so an ask with no in-process answerer parks in the Map<id, resolve>
 * instead of failing closed.
 */
async function parkAsk(harness: Harness): Promise<ParkedAsk> {
  const { agent, appended } = fakeAgent()
  const asking = harness.ctx.approval.request({ agent, toolName: 'deafness-probe', reason: 'parked-approval-deafness repro' })
  await vi.waitFor(() => {
    if (!appended.some(event => event.type === 'approval/asked')) throw new Error('approval/asked not appended yet')
  })
  await settle()
  const asked = appended.find(event => event.type === 'approval/asked')
  return { asking, askId: String(asked?.data.id), appended }
}

/** One `session/approval-respond` request frame for an ask id. */
function respondFrame(id: string, rpcId: string, outcome: ApprovalOutcome): Record<string, unknown> {
  return { jsonrpc: '2.0', id: rpcId, method: 'session/approval-respond', params: { id, outcome } }
}

describe('parked-approval deafness repro (132号)', () => {
  it('S1 baseline: a parked ask settles in milliseconds through the respond RPC', async () => {
    const harness = await mountHarness()
    try {
      const park = await parkAsk(harness)

      const sentAt = Date.now()
      harness.send(respondFrame(park.askId, 'ar-s1', 'allowed-once'))
      const frame = await harness.waitForFrame(frame => frame.id === 'ar-s1', 'approval-respond response frame')
      expect(frame).toEqual({ jsonrpc: '2.0', id: 'ar-s1', result: {} })
      expect(Date.now() - sentAt).toBeLessThan(1000)

      // The parked promise settled with the decision, and the audit pair closed.
      await expect(park.asking).resolves.toBe('allowed-once')
      expect(park.appended.map(event => event.type)).toEqual(['approval/asked', 'approval/decided'])
      expect(park.appended[1]?.data).toMatchObject({ outcome: 'allowed-once' })
    } finally {
      await cleanupHarness(harness)
    }
  })

  it('S2 deaf state: after the jsonrpc.serve disposer the parked ask never hears respond', { timeout: 15_000 }, async () => {
    const harness = await mountHarness()
    try {
      const park = await parkAsk(harness)
      const respondSpy = vi.spyOn(harness.ctx.approval, 'respondExternal')

      // The ONLY production close point: disposing the scope that mounts the
      // 'jsonrpc.serve' effect runs `await server.shutdown()` (no sessions —
      // fast) and then `transport.close()`.
      await harness.fiber.dispose()

      const framesBefore = harness.frames().length
      harness.send(respondFrame(park.askId, 'ar-s2', 'allowed-once'))
      // A 2s window with zero output proves deafness; the window itself
      // completing proves the process and event loop are perfectly healthy.
      await new Promise(resolve => setTimeout(resolve, 2000))

      expect(harness.frames().length).toBe(framesBefore)
      expect(harness.frames().some(frame => frame.id === 'ar-s2')).toBe(false)
      // The request handler never ran: respondExternal was never called, and
      // the parked ask is still sitting in the Map — proven by settling it
      // directly afterwards (true = the park survived the whole window).
      expect(respondSpy).not.toHaveBeenCalled()
      expect(harness.ctx.approval.respondExternal(ApprovalRequestId(park.askId), 'rejected')).toBe(true)

      // 卡点归因: packages/sdk/protocol/src/transport.ts:87-92 — close()
      // removes the input stream's 'data' listener, and nothing else ever
      // consumes that stream: written chunks are never parsed, handleLine
      // never runs, so the parked ask (user-approval Map<id, resolve>) is
      // unreachable from the wire forever. The process lives; it just cannot
      // hear — exactly the incident's 12-minutes-of-zero-answers shape.
      void park.asking.catch(() => { /* the direct respondExternal above settled it */ })
    } finally {
      await cleanupHarness(harness)
    }
  })

  it('S3 an unrelated async hang never deafens the transport', { timeout: 15_000 }, async () => {
    const harness = await mountHarness({
      beforeServer: async (ctx) => {
        // A Loader entry whose apply never settles: `initialize` awaits
        // loader settlement, so that request hangs forever — a genuine
        // plugin-side async hang — while the effect disposer stays untouched.
        await ctx.plugin(Loader)
        ctx.loader.builtins['deafness-hang'] = {
          inject: [],
          async apply() { await new Promise<void>(() => { /* deliberately never settles */ }) },
        }
        void ctx.loader.create({ name: 'cordis:deafness-hang' })
      },
    })
    try {
      harness.send({
        jsonrpc: '2.0',
        id: 'init-hang',
        method: 'initialize',
        params: { cwd: '.', provider: 'deepseek-official', model: 'x' },
      })
      await new Promise(resolve => setTimeout(resolve, 300))
      // The async hang is in place: initialize never answers.
      expect(harness.frames().some(frame => frame.id === 'init-hang')).toBe(false)

      // Against that hang, a parked ask still settles through the wire in
      // milliseconds — line processing never serializes behind another
      // request's await, so no flush/worker/any-await hang can explain the
      // incident's unanswered approval-respond stream.
      const park = await parkAsk(harness)
      harness.send(respondFrame(park.askId, 'ar-s3', 'rejected'))
      const frame = await harness.waitForFrame(frame => frame.id === 'ar-s3', 'approval-respond response despite the hang')
      expect(frame).toEqual({ jsonrpc: '2.0', id: 'ar-s3', result: {} })
      await expect(park.asking).resolves.toBe('rejected')
    } finally {
      await cleanupHarness(harness, { abandon: true })
    }
  })

  it('S4 a synchronous event-loop block delays the response but never loses it', { timeout: 15_000 }, async () => {
    const harness = await mountHarness()
    try {
      const park = await parkAsk(harness)

      harness.send(respondFrame(park.askId, 'ar-s4', 'allowed-once'))
      // Busy-block the loop for 2s after the line was written: no listener
      // can run during the block. If event-loop congestion were the deafness
      // mechanism, this is where frames would vanish; instead the chunk is
      // buffered by the stream and delivered the moment the loop breathes.
      const blockStart = Date.now()
      let spin = 0
      while (Date.now() - blockStart < 2000) spin += Math.sqrt(spin + 1)
      expect(Date.now() - blockStart).toBeGreaterThanOrEqual(2000)
      expect(spin).toBeGreaterThan(0)

      const frame = await harness.waitForFrame(frame => frame.id === 'ar-s4', 'approval-respond response after the block')
      expect(frame).toEqual({ jsonrpc: '2.0', id: 'ar-s4', result: {} })
      await expect(park.asking).resolves.toBe('allowed-once')
    } finally {
      await cleanupHarness(harness)
    }
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
})
