import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as TurnReaper from '@deepseek-ai/dsh-subprocess-local/turn-reaper'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** Shell spec with a short escalation grace so a reap is observable quickly. */
function shell(command: string): SubprocessSpawnSpec {
  return {
    argv: ['bash', '-c', command],
    cwd: process.cwd(),
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64_000 },
      stderr: { maxBytes: 64_000 },
    },
    graceMs: 200,
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function waitForGone(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return !alive(pid)
}

function emitTurnEnd(ctx: Context): void {
  ctx.emit('session/event', {} as never, { type: 'turn/end' } as never)
}

describe('subprocess turn reaper', () => {
  const directories: string[] = []
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  it('reaps a settled command whose background descendant keeps the range alive', async () => {
    if (process.platform === 'win32') return
    const directory = mkdtempSync(join(tmpdir(), 'dsh-turn-reaper-'))
    directories.push(directory)
    const pidFile = join(directory, 'child.pid')
    const ctx = new Context()
    const runtimeFiber = await ctx.plugin(LocalSubprocessRuntime)
    const reaperFiber = await ctx.plugin(TurnReaper)
    try {
      const handle = ctx.subprocess.spawn(shell(`sleep 60 & echo $! > ${pidFile}`))
      await handle.done
      // The spawned shell has settled; the background child survived inside
      // the same managed range — the residual form a finished run must not
      // leave behind.
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      expect(pid).toBeGreaterThan(1)
      expect(alive(pid)).toBe(true)

      emitTurnEnd(ctx)

      await expect(waitForGone(pid)).resolves.toBe(true)
    } finally {
      await reaperFiber.dispose()
      await runtimeFiber.dispose()
    }
  })

  it('reaps the background descendant when a killed run tears the runtime down', async () => {
    if (process.platform === 'win32') return
    const directory = mkdtempSync(join(tmpdir(), 'dsh-turn-reaper-kill-'))
    directories.push(directory)
    const pidFile = join(directory, 'child.pid')
    const ctx = new Context()
    const runtimeFiber = await ctx.plugin(LocalSubprocessRuntime)
    const reaperFiber = await ctx.plugin(TurnReaper)
    try {
      const handle = ctx.subprocess.spawn(shell(`sleep 60 & echo $! > ${pidFile}`))
      await handle.done
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      expect(alive(pid)).toBe(true)

      // A killed run closes the generation; the SDK client walks shutdown →
      // EOF → SIGTERM and the kernel's signal handler disposes this runtime.
      // Disposal must still own the settled range and reap its survivor.
      await runtimeFiber.dispose()

      await expect(waitForGone(pid)).resolves.toBe(true)
    } finally {
      await reaperFiber.dispose()
    }
  })

  it('leaves a command that is still running alone at the turn boundary', async () => {
    if (process.platform === 'win32') return
    const directory = mkdtempSync(join(tmpdir(), 'dsh-turn-reaper-live-'))
    directories.push(directory)
    const pidFile = join(directory, 'direct.pid')
    const ctx = new Context()
    const runtimeFiber = await ctx.plugin(LocalSubprocessRuntime)
    const reaperFiber = await ctx.plugin(TurnReaper)
    try {
      const handle = ctx.subprocess.spawn(shell(`echo $$ > ${pidFile}; sleep 60`))
      const deadline = Date.now() + 5_000
      let raw = ''
      while (raw === '' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20))
        try {
          raw = readFileSync(pidFile, 'utf8').trim()
        } catch {
          // The shell may not have created the file yet.
        }
      }
      const pid = Number(raw)
      expect(pid).toBeGreaterThan(1)

      emitTurnEnd(ctx)
      await new Promise(resolve => setTimeout(resolve, 500))

      // A live direct process is service work, not a leftover: the sweep must
      // not touch it, and its result still has to settle normally.
      expect(alive(pid)).toBe(true)
      handle.terminate()
      await handle.waitForExit()
    } finally {
      await reaperFiber.dispose()
      await runtimeFiber.dispose()
    }
  })

  it('reaps on every terminal turn reason and ignores non-boundary events', async () => {
    const ctx = new Context()
    const reap = vi.fn(async () => 0)
    const reaperFiber = await ctx.plugin(TurnReaper)
    try {
      // No provider yet: the injected reaper stays inactive.
      emitTurnEnd(ctx)
      expect(reap).not.toHaveBeenCalled()

      // Installing a provider activates the injected reaper; the capability
      // check keeps providers without residual-range support untouched.
      ctx.provide('subprocess', { reapSettledRanges: reap } as never)
      await Promise.resolve()
      ctx.emit('session/event', {} as never, { type: 'turn/start' } as never)
      ctx.emit('session/event', {} as never, { type: 'step/end' } as never)
      expect(reap).not.toHaveBeenCalled()

      for (const reason of ['completed', 'aborted', 'error', 'max-tokens']) {
        ctx.emit('session/event', {} as never, { type: 'turn/end', data: { turn: 1, reason: { kind: reason } } } as never)
      }
      expect(reap).toHaveBeenCalledTimes(4)
    } finally {
      await reaperFiber.dispose()
    }
  })
})
