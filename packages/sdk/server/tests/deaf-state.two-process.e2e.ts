/**
 * Real two-process parked-approval deafness over the built lib (132号 incident
 * production shape): a child Node process mounts the real sdk-jsonrpc-server
 * plugin on the REAL stdio face beside a test plugin whose effect disposer
 * never settles. After a `shutdown` RPC the plugin's exit task runs — the
 * shutdown result frame lands, `transport.close()` detaches the stdin
 * listeners (cordis unloads child fibers concurrently, so the sibling hung
 * disposer cannot block it), and the hung disposer keeps `rootFiber.dispose()`
 * pending forever, so `exit(0)` is unreachable. The child then stays alive and
 * deaf: `session/approval-respond` frames over ≥5s produce zero output frames.
 * SIGTERM — the app bin's signal exit owner — is the only way out (exit 0).
 * Keyless; tmpdir session root; POSIX pipe semantics only.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const CHILD = fileURLToPath(new URL('./fixtures/deaf-state-child.mjs', import.meta.url))

const dirs: string[] = []
const children: ChildProcess[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** Parse one JSON object per stdout line; non-JSON lines (readiness markers) are skipped. */
function framesOf(output: string): Record<string, unknown>[] {
  return output.split('\n').flatMap((line) => {
    const text = line.trim()
    if (!text) return []
    try {
      return [JSON.parse(text) as Record<string, unknown>]
    } catch {
      return []
    }
  })
}

/** Liveness probe: zombies pass kill(pid, 0); the signal is harmless there. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe.skipIf(process.platform === 'win32')('two-process parked-approval deaf state (built lib)', () => {
  it('answers before shutdown, goes deaf while alive after it, and exits 0 only on SIGTERM', { timeout: 90_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-deaf-2proc-'))
    dirs.push(root)
    const child = spawn(process.execPath, [CHILD, root], { stdio: ['pipe', 'pipe', 'inherit'] })
    children.push(child)
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    const frames = (): Record<string, unknown>[] => framesOf(output)
    const send = (frame: Record<string, unknown>): void => { child.stdin?.write(`${JSON.stringify(frame)}\n`) }
    const waitForFrame = async (
      predicate: (frame: Record<string, unknown>) => boolean,
      description: string,
    ): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + 15_000
      for (;;) {
        const frame = frames().find(predicate)
        if (frame !== undefined) return frame
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`child died while waiting for ${description}`)
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`)
        await sleep(20)
      }
    }

    // The child serves over the real stdio face.
    const readyDeadline = Date.now() + 15_000
    while (!output.includes('serving') && Date.now() < readyDeadline) await sleep(20)
    expect(output).toContain('serving')

    // Reader-alive baseline: an unknown-id approval-respond comes back as a
    // -32603 error frame — the line reader and the approval seam are both live.
    send({ jsonrpc: '2.0', id: 'ar-baseline', method: 'session/approval-respond', params: { id: 'no-such-approval', outcome: 'rejected' } })
    const baseline = await waitForFrame(frame => frame.id === 'ar-baseline', 'baseline error frame')
    expect(baseline.error).toMatchObject({ code: -32603 })
    expect(String((baseline.error as { message?: string }).message)).toContain('no pending approval')

    // shutdown: the result frame lands, then disposeAndExit runs —
    // transport.close() detaches the stdin listeners, while the hung witness
    // disposer keeps rootFiber.dispose() (and therefore exit(0)) pending
    // forever. 卡点: packages/sdk/protocol/src/transport.ts:87-92 — after
    // close() removes the 'data' listener nothing consumes stdin anymore.
    send({ jsonrpc: '2.0', id: 'sd-1', method: 'shutdown' })
    const shutdown = await waitForFrame(frame => frame.id === 'sd-1', 'shutdown result frame')
    expect(shutdown.result).toEqual({})
    // Deterministic aliveness window: disposeAndExit had its chance (setImmediate
    // → flush → rootFiber.dispose()); the hung witness keeps exit(0) pending and
    // the keep-alive beat means the loop can never drain — poll continuously
    // instead of trusting one sleep.
    const disposeWindowEnd = Date.now() + 3000
    while (Date.now() < disposeWindowEnd) {
      expect(child.exitCode).toBeNull()
      await sleep(50)
    }

    // Deaf state: approval-respond frames over ≥5s produce ZERO output frames
    // while the process stays alive — the incident's parked僵死 shape
    // (致聋 + 存活, exit 0 never arriving on its own).
    const framesBefore = frames().length
    const deafStart = Date.now()
    let sent = 0
    while (Date.now() - deafStart < 5000) {
      send({
        jsonrpc: '2.0',
        id: `ar-deaf-${sent}`,
        method: 'session/approval-respond',
        params: { id: 'no-such-approval', outcome: 'rejected' },
      })
      sent += 1
      await sleep(400)
      expect(child.exitCode).toBeNull()
    }
    expect(sent).toBeGreaterThanOrEqual(10)
    expect(frames().length).toBe(framesBefore)
    expect(child.pid).toBeDefined()
    expect(alive(child.pid as number)).toBe(true)

    // SIGTERM is the only exit: the fixture-owned signal handler exits 0 in
    // seconds — the process was never wedged at the loop level, just deaf.
    const termStart = Date.now()
    child.kill('SIGTERM')
    const exitDeadline = termStart + 5000
    while (child.exitCode === null && child.signalCode === null && Date.now() < exitDeadline) await sleep(20)
    expect(child.exitCode).toBe(0)
    expect(Date.now() - termStart).toBeLessThan(5000)
  })
})
