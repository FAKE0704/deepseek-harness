/**
 * SDK-facing JSON-RPC plugin over stdio. The selected dsh profile decides
 * whether to load it; see the single-launch Agent Note and package README.
 * Stdout is reserved for protocol frames, so the tree must not load a stdout logger.
 * This plugin answers `shutdown`, disposes the complete root runtime, and exits 0.
 * A stdin EOF — the deterministic signal that the parent transport face died
 * with its process — arms a bounded self-exit: after a grace window the plugin
 * reuses the exact shutdown path (flush → root disposal → exit 0) under hard
 * deadlines, so an orphaned kernel cannot hold its session locks forever.
 * Signal exits stay owned by the app bin. Keep named plugin exports with no
 * default export so Loader `unwrapExports` preserves `name`, `inject`,
 * `Config`, and `apply`.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-server
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Readable, Writable } from 'node:stream'
import Schema from '@deepseek-ai/schemastery'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { HarnessSdkJsonRpcServer } from './server.ts'

export * from './server.ts'

export const name = 'sdk-jsonrpc-server'
// Only the agent factory is required; initialize reads the optional LLM seam with ctx.get().
export const inject = ['agents']

/** Environment switch for the EOF self-exit grace: `off` or a negative number disables, `>=0` is the grace in milliseconds. */
export const EOF_EXIT_GRACE_ENV = 'DSH_SDK_EOF_EXIT_GRACE_MS'

/** Default grace for the production stdin transport; an injected test input never self-exits by default. */
const DEFAULT_EOF_EXIT_GRACE_MS = 5000
/** Suicide-path deadlines: flush ≤1s, dispose ≤10s, then an unconditional exit — an orphan has no external SIGTERM to lean on. */
const FLUSH_DEADLINE_MS = 1000
const DISPOSE_DEADLINE_MS = 10_000
/** Control-line prefix; stderr only, stdout is protocol-reserved. */
const NOTIFY_PREFIX = '[sdk-jsonrpc-server]'

/** Resolved EOF self-exit policy: either disabled or a grace window in milliseconds. */
type EofExitGrace = { kind: 'disabled' } | { kind: 'grace'; ms: number }

/** JSON-RPC deployment config plus runtime-only test hooks. */
export interface JsonRpcConfig {
  /** Report max-token turn/subagent termination as a successful SDK result. */
  maxTokensAsSuccess?: boolean
  /**
   * stdin-EOF self-exit grace: `>=0` milliseconds (`0` exits immediately after
   * EOF, still through the full dispose), negative disables. `undefined` falls
   * to `DSH_SDK_EOF_EXIT_GRACE_MS` and then the transport-shape default.
   */
  eofExitGraceMs?: number
  /** Transport input override; production uses `process.stdin`. */
  input?: Readable
  /** Transport output override; production uses `process.stdout`. */
  output?: Writable
  /** Process-exit override; production uses `process.exit`. */
  exit?: (code: number) => void
}

export const Config: Schema<JsonRpcConfig> = Schema.object({
  maxTokensAsSuccess: Schema.boolean().default(false),
  eofExitGraceMs: Schema.number(),
})

/**
 * Write one control line to a possibly dying stdio face without ever
 * surfacing a pipe error as an uncaught exception: synchronous throws are
 * swallowed, and a one-shot `error` guard absorbs the asynchronous EPIPE.
 * The guard detaches as soon as the write settles (success callback, absorbed
 * error, or throw), so it never becomes a global error suppressor.
 */
function writeControlled(stream: NodeJS.WriteStream, line: string): void {
  const detachGuard = (): void => { stream.off('error', detachGuard) }
  stream.once('error', detachGuard)
  try {
    stream.write(line, () => { detachGuard() })
  } catch {
    detachGuard()
  }
}

/** Warn one deployment-level config problem on stderr, under the same controlled-write discipline. */
function warnControlled(line: string): void {
  writeControlled(process.stderr, `${NOTIFY_PREFIX} ${line}\n`)
}

/**
 * Parse one raw grace value — a `number` from config, a `string` from the
 * environment. `off`/negative disables, `>=0` is milliseconds; anything else
 * warns and returns `undefined` so the next resolution tier applies (a
 * typoed switch must degrade to the default, visibly, not fail the boot).
 */
function parseEofExitGrace(raw: number | string | undefined): EofExitGrace | undefined {
  if (raw === undefined) return undefined
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      warnControlled(`invalid ${EOF_EXIT_GRACE_ENV} value ${String(raw)}; ignoring`)
      return undefined
    }
    return raw >= 0 ? { kind: 'grace', ms: raw } : { kind: 'disabled' }
  }
  const text = raw.trim()
  if (text === 'off') return { kind: 'disabled' }
  const value = Number(text)
  if (text === '' || !Number.isFinite(value)) {
    warnControlled(`invalid ${EOF_EXIT_GRACE_ENV} value ${JSON.stringify(raw)}; ignoring`)
    return undefined
  }
  return value >= 0 ? { kind: 'grace', ms: value } : { kind: 'disabled' }
}

/**
 * Resolve the EOF self-exit policy: explicit config, then the launch
 * environment snapshot (falling back to the inherited environment), then the
 * transport-shape default — an injected test input never self-exits unless a
 * value is explicit, so existing suites keep their byte-identical EOF
 * behavior.
 */
function resolveEofExitGrace(ctx: Context, config: JsonRpcConfig): EofExitGrace {
  const fromConfig = parseEofExitGrace(config.eofExitGraceMs)
  if (fromConfig !== undefined) return fromConfig
  const fromEnv = parseEofExitGrace(launchEnvironmentOf(ctx).get(EOF_EXIT_GRACE_ENV)?.value)
  if (fromEnv !== undefined) return fromEnv
  return config.input !== undefined ? { kind: 'disabled' } : { kind: 'grace', ms: DEFAULT_EOF_EXIT_GRACE_MS }
}

/**
 * Serve SDK requests over the configured streams. Effect disposal shuts down
 * SDK-created agents and closes the transport. A `shutdown` response is flushed
 * before the root runtime is disposed and the process exits 0. A stdin EOF arms
 * the bounded self-exit: after the grace window the same dispose path runs
 * under flush/dispose deadlines whose timeout is an unconditional exit — the
 * kernel lock dies with the process even if disposal itself hangs.
 */
export function apply(ctx: Context, config: JsonRpcConfig): void {
  // Cordis applies the schema default before invoking the plugin.
  const resolvedConfig = config as JsonRpcConfig & { maxTokensAsSuccess: boolean }
  // Protocol shutdown owns the complete runtime process, so it must await the
  // root lifecycle (including persistence) before exiting.
  const rootFiber = ctx.root.fiber
  /* v8 ignore next -- production stdio wiring; tests always inject the runtime hooks */
  const input = config.input ?? process.stdin
  /* v8 ignore next -- production stdio wiring; tests always inject the runtime hooks */
  const output = config.output ?? process.stdout
  /* v8 ignore next -- production exit wiring; tests always inject the runtime hooks */
  const exit = config.exit ?? ((code: number): void => { process.exit(code) })

  const transport = new JsonRpcLineTransport(input, output)
  // Attach the external approval responder as soon as the service mounts
  // (order-independent): with an SDK peer serving this runtime, unanswered
  // approval asks park for `session/approval-respond` instead of failing
  // closed at once. Class tests construct the server against a partial
  // context, so the attach lives here at the production assembly point.
  ctx.inject(['approval'], (scope: Context) => {
    scope.approval.enableExternalResponder()
  })
  const server = new HarnessSdkJsonRpcServer(ctx, transport, {
    maxTokensAsSuccess: resolvedConfig.maxTokensAsSuccess,
  })

  // Share one exit task so racing shutdown requests and the EOF self-exit
  // cannot dispose the root or exit the process more than once; `exitOnce`
  // additionally de-duplicates against the self-exit deadline timers.
  let exitTask: Promise<void> | undefined
  let exited = false
  const exitOnce = (code: number): void => {
    if (exited) return
    exited = true
    exit(code)
  }
  // The self-exit leans on this hook to swap the flush deadline for the
  // dispose deadline once the flush barrier settles; the shutdown-RPC path
  // leaves it unset (a live parent keeps the SIGTERM hard top reachable).
  let onFlushSettled: (() => void) | undefined
  const runDisposeAndExit = async (): Promise<void> => {
    await Promise.allSettled([Promise.resolve().then(() => transport.flush())])
    onFlushSettled?.()
    await Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())])
    exitOnce(0)
  }
  const disposeAndExit = (): Promise<void> => {
    exitTask ??= runDisposeAndExit()
    return exitTask
  }

  // Bounded self-exit after the stdin EOF grace (parent transport death). The
  // orphan has no external signal source, so each dispose stage leans on its
  // own hard deadline: an unconditional exit fires even when disposal hangs,
  // and the kernel lock dies with the process regardless of dispose
  // correctness.
  const armSuicideDeadline = (ms: number): NodeJS.Timeout => {
    const timer = setTimeout(() => { exitOnce(0) }, ms)
    // A deadline must never keep the orphan's event loop alive on its own.
    timer.unref()
    return timer
  }
  let suicideDeadline: NodeJS.Timeout | undefined
  const suicideExit = (): void => {
    clearTimeout(suicideDeadline)
    suicideDeadline = armSuicideDeadline(FLUSH_DEADLINE_MS)
    onFlushSettled = (): void => {
      clearTimeout(suicideDeadline)
      suicideDeadline = armSuicideDeadline(DISPOSE_DEADLINE_MS)
    }
    exitTask ??= runDisposeAndExit()
  }

  // EOF after start() arms the bounded self-exit after the grace window. The
  // transport keeps its own listener (protocol semantics unchanged); this one
  // is detached symmetrically on effect disposal, so close-without-EOF never
  // leaves a ghost timer and EOF-then-close cancels the armed one.
  const grace = resolveEofExitGrace(ctx, config)
  let graceTimer: NodeJS.Timeout | undefined
  const onInputEnd = grace.kind === 'grace'
    ? (): void => {
      writeControlled(process.stderr, `${NOTIFY_PREFIX} input closed; exiting in ${grace.ms}ms\n`)
      const timer = setTimeout(suicideExit, grace.ms)
      // The grace window must not keep an orphan alive artificially.
      timer.unref()
      graceTimer = timer
    }
    : undefined
  const detachEof = onInputEnd === undefined
    ? undefined
    : (): void => {
      input.off('end', onInputEnd)
      clearTimeout(graceTimer)
    }
  if (onInputEnd !== undefined) input.once('end', onInputEnd)

  transport.onRequest(async (method, params) => {
    // `initialize` is the SDK's readiness boundary. This plugin can activate
    // before async sibling Loader entries (for example an MCP client's initial
    // tool discovery), so do not advertise a ready runtime until the complete
    // current tree has settled. Loader settlement joins entry imports, fiber
    // lifecycle work, and synchronous effect registration; no scheduler delay
    // is part of readiness. A hand-built context without Loader remains
    // immediately usable.
    if (method === 'initialize') {
      await ctx.get('loader')?.await()
    }
    const result = await server.handleRequest(method, params)
    if (method === 'shutdown') {
      // Run after the handler result is written; the task then flushes, disposes, and exits.
      setImmediate(() => { void disposeAndExit() })
    }
    return result
  })

  ctx.effect(() => {
    transport.start()
    return async () => {
      detachEof?.()
      await server.shutdown()
      transport.close()
    }
  }, 'jsonrpc.serve')
}
