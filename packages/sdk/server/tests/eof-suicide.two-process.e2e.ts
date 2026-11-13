/**
 * Real two-process EOF self-exit over one shared session root: a child Node
 * process (running the built plugin under plain Node) serves JSON-RPC over
 * the real stdio face while holding the session write lock; SIGKILLing its
 * parent closes the child's stdin — the orphan arms the bounded self-exit and
 * exits 0 inside the grace-plus-deadline window, freeing the lock for the
 * next generation immediately. Keyless; POSIX pipe semantics only.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const PARENT = fileURLToPath(new URL('./fixtures/eof-suicide-parent.mjs', import.meta.url))
const SESSION = 'eof-suicide-session'
const GRACE_MS = 400
/** Grace + flush 1s + dispose 10s deadlines, with scheduler slack. */
const CEILING_MS = GRACE_MS + 12_000

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('two-process EOF self-exit (built lib)', () => {
  it('frees the session lock inside the grace-plus-deadline window after the parent dies', { timeout: 45_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-eof-2proc-'))
    dirs.push(root)
    const exitCodeFile = join(root, 'exit-code')
    const parent = spawn(process.execPath, [PARENT, root, SESSION, exitCodeFile, String(GRACE_MS)], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let childPid: number | undefined
    let output = ''
    parent.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      const match = /child (\d+)/.exec(output)
      if (match) childPid = Number(match[1])
    })
    try {
      // Wait until the child serves and holds the lock.
      const readyDeadline = Date.now() + 15_000
      while (!output.includes('holding') && Date.now() < readyDeadline) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(output).toContain('holding')
      expect(typeof childPid).toBe('number')

      // A live holder excludes this generation — exactly the incident shape.
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
      const mine = ctx.sessionPersistence
      await expect(mine.open(SessionId(SESSION), 'write')).rejects.toThrow()

      // Crash the parent: the child's stdin write end dies with it.
      const crashedAt = Date.now()
      parent.kill('SIGKILL')

      // The orphan must die within the grace-plus-deadline ceiling. A child
      // whose loop still has live handles (in-flight turns, connections) runs
      // the full dispose path and records exit 0 through the override file; a
      // fully idle orphan's unref'd grace timer lets Node exit naturally with
      // code 0 before the timer fires — both shapes release the kernel lock.
      const exitDeadline = crashedAt + CEILING_MS
      const gone = (): boolean => {
        if (childPid === undefined) return false
        try {
          process.kill(childPid, 0)
          return false
        } catch {
          return true
        }
      }
      while (!existsSync(exitCodeFile) && !gone() && Date.now() < exitDeadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      const recorded = existsSync(exitCodeFile)
      const died = gone()
      expect(recorded || died).toBe(true)
      expect(Date.now() - crashedAt).toBeLessThanOrEqual(CEILING_MS)
      if (recorded) expect(await readFile(exitCodeFile, 'utf8')).toBe('0')

      // The next generation takes the lock immediately.
      const taken = await mine.open(SessionId(SESSION), 'write')
      await taken.append([{ type: 'turn/start', seq: SessionSeq(2), time: 3, data: { turn: 2 } }])
      expect((await taken.read()).events.map(event => event.seq)).toEqual([0, 1, 2])
      await taken.close()
    } finally {
      if (parent.exitCode === null && !parent.killed) parent.kill('SIGKILL')
      // Police a leftover child (zombies pass kill(0); the signal is harmless there).
      if (childPid !== undefined) {
        try {
          process.kill(childPid, 0)
          process.kill(childPid, 'SIGKILL')
        } catch {
          // Already gone — the expected shape.
        }
      }
    }
  })
})
