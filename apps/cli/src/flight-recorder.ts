/**
 * Runtime flight recorder for long-lived dsh profile processes.
 *
 * The 132号 incident class (approval-parked runtime goes deaf, then dies with
 * `exit code: 0` and an aborted-turn signature) left no kernel-side evidence:
 * stderr existed only in a host-side memory tail, and neither the exit code nor
 * the teardown initiator was ever durably recorded. This module gives every
 * profile process a durable, zero-dependency death diary under
 * `<dsh-home>/logs/`, so the next recurrence adjudicates itself:
 *
 * - `boot`            — pid/ppid/argv/profile/home identity at install time
 * - `signal`          — SIGTERM/SIGINT receipt with process uptime (the
 *                       cooperative teardown ladder, sdk client `dispose.ts`,
 *                       escalates from stdin EOF to SIGTERM, so both trails
 *                       must be distinguishable)
 * - `stdin_end`/`stdin_error` — the EOF leg of that same ladder, which produces
 *                       the graceful `exit code: 0` without any signal at all
 * - `stderr` copy     — full raw tee of process.stderr, so a dying runtime's
 *                       last words survive the process
 * - `exit`            — final exit code (captured synchronously)
 *
 * Every write is fire-and-forget append via `appendFileSync` and silently
 * ignored on failure: the recorder must never be able to take the runtime down.
 *
 * @module @deepseek-ai/dsh-cli/flight-recorder
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** Newly observable runtime facts, one JSON line per row. */
export type FlightEvent =
  | 'boot'
  | 'signal'
  | 'stdin_end'
  | 'stdin_error'
  | 'exit'

/** Minimal writable surface (process.stderr shape) so tests need no real tty. */
export interface FlightWriteStream {
  write(chunk: string): unknown
}

/** Minimal readable surface (process.stdin shape) so tests need no real pipe. */
export interface FlightReadStream {
  on(event: 'end', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  off(event: 'end', listener: () => void): unknown
  off(event: 'error', listener: (error: Error) => void): unknown
}

/** Installed recorder handle; `dispose` detaches process-wide listeners. */
export interface FlightRecorder {
  /** Append one structured row to the flight log. Never throws. */
  record(event: FlightEvent, fields?: Record<string, unknown>): void
  /** Strip the stderr tee and process listeners (tests; production runs to exit). */
  dispose(): void
}

export interface FlightRecorderOptions {
  /** dsh home directory; rows land under `<home>/logs/`. */
  home: string
  /** Profile name disambiguates concurrent sdk/schedule/dev runtimes. */
  profile: string
  /** Writable stderr to tee (production: `process.stderr`). */
  stderr?: FlightWriteStream
  /** Readable stdin to watch for the teardown ladder's EOF leg (production: `process.stdin`). */
  stdin?: FlightReadStream
  /** Injectable clock (production: `Date.now`). */
  now?: () => number
  /** Injectable pid (production: `process.pid`). */
  pid?: number
}

interface FlightRow extends Record<string, unknown> {
  ts: string
  event: FlightEvent
  pid: number
}

const MAX_STDERR_LOG_BYTES = 5 * 1024 * 1024

/**
 * Install the recorder against the live process. Signal and stdin listeners are
 * added, never replacing existing ones, so profile-boot's own interrupt wiring
 * keeps working; registration order puts the recorder's row first, timestamping
 * the teardown initiator before any disposal starts.
 */
export function installFlightRecorder(options: FlightRecorderOptions): FlightRecorder {
  const pid = options.pid ?? process.pid
  const now = options.now ?? (() => Date.now())
  const logDir = join(options.home, 'logs')
  const flightFile = join(logDir, `runtime-flight-${options.profile}-${pid}.jsonl`)
  const stderrFile = join(logDir, `runtime-stderr-${options.profile}-${pid}.log`)
  let stderrLoggedBytes = 0

  const writeRow = (row: FlightRow): void => {
    try {
      mkdirSync(logDir, { recursive: true })
      appendFileSync(flightFile, `${JSON.stringify(row)}\n`)
    } catch {
      /* the recorder must never take the runtime down */
    }
  }

  const record = (event: FlightEvent, fields: Record<string, unknown> = {}): void => {
    writeRow({ ts: new Date(now()).toISOString(), event, pid, ...fields })
  }

  const bootAt = now()
  record('boot', {
    ppid: typeof process.ppid === 'number' ? process.ppid : undefined,
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    node: process.version,
  })

  const onTerm = (): void => record('signal', { signal: 'SIGTERM', uptimeMs: now() - bootAt })
  const onInt = (): void => record('signal', { signal: 'SIGINT', uptimeMs: now() - bootAt })
  const onExit = (): void => {
    // Synchronous append is the only write that survives the exit edge.
    try {
      mkdirSync(logDir, { recursive: true })
      appendFileSync(flightFile, `${JSON.stringify({
        ts: new Date(now()).toISOString(),
        event: 'exit' as const,
        pid,
        exitCode: process.exitCode ?? 0,
        uptimeMs: now() - bootAt,
      })}\n`)
    } catch {
      /* ignore */
    }
  }

  const stdin = options.stdin
  const onEnd = (): void => record('stdin_end', { uptimeMs: now() - bootAt })
  const onError = (error: Error): void => record('stdin_error', { error: error.message, uptimeMs: now() - bootAt })

  process.on('SIGTERM', onTerm)
  process.on('SIGINT', onInt)
  process.on('exit', onExit)
  stdin?.on('end', onEnd)
  stdin?.on('error', onError)

  const stderr = options.stderr
  // Capture the property value itself (no bind) so dispose restores the exact
  // original identity — tests and process teardown both assert on it.
  const originalWrite = stderr?.write
  if (stderr && originalWrite) {
    stderr.write = (chunk: string, ...rest: never[]): unknown => {
      try {
        if (stderrLoggedBytes < MAX_STDERR_LOG_BYTES) {
          const text = typeof chunk === 'string' ? chunk : String(chunk)
          mkdirSync(logDir, { recursive: true })
          appendFileSync(stderrFile, text)
          stderrLoggedBytes += text.length
        }
      } catch {
        /* tee is best-effort */
      }
      return (originalWrite as (...args: unknown[]) => unknown).call(stderr, chunk, ...rest)
    }
  }

  return {
    record,
    dispose(): void {
      process.off('SIGTERM', onTerm)
      process.off('SIGINT', onInt)
      process.off('exit', onExit)
      stdin?.off('end', onEnd)
      stdin?.off('error', onError)
      if (stderr && originalWrite) stderr.write = originalWrite
    },
  }
}
