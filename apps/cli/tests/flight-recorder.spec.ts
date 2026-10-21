import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { installFlightRecorder, type FlightWriteStream } from '../src/flight-recorder.ts'

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flight-'))
  return dir
}

/** stderr stand-in capturing tee copies while keeping write passthrough observable. */
function fakeStderr(): FlightWriteStream & { writes: string[] } {
  const writes: string[] = []
  return { writes, write(chunk: string) { writes.push(chunk) } }
}

function fakeStdin(): EventEmitter {
  return new EventEmitter()
}

describe('installFlightRecorder', () => {
  it('records boot immediately and structured rows thereafter, never throwing on missing dirs', () => {
    const home = tempHome()
    try {
      const recorder = installFlightRecorder({ home, profile: 'sdk', pid: 4242, now: () => 1_700_000_000_000 })
      expect(() => recorder.record('signal', { signal: 'SIGTERM', uptimeMs: 5 })).not.toThrow()
      const flight = join(home, 'logs', 'runtime-flight-sdk-4242.jsonl')
      expect(existsSync(flight)).toBe(true)
      const rows = readFileSync(flight, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
      expect(rows[0]?.event).toBe('boot')
      expect(rows[0]?.pid).toBe(4242)
      expect(rows[1]?.event).toBe('signal')
      expect(rows[1]?.signal).toBe('SIGTERM')
      expect(typeof rows[0]?.ts).toBe('string')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('tees stderr verbatim into a sibling log while leaving passthrough intact', () => {
    const home = tempHome()
    try {
      const stderr = fakeStderr()
      installFlightRecorder({ home, profile: 'sdk', pid: 5, stderr })
      stderr.write('last words before death\n')
      stderr.write('second line\n')
      expect(stderr.writes).toEqual(['last words before death\n', 'second line\n'])
      const tee = readFileSync(join(home, 'logs', 'runtime-stderr-sdk-5.log'), 'utf8')
      expect(tee).toBe('last words before death\nsecond line\n')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('logs stdin EOF and errors — the dispose ladder\'s graceful exit-0 leg', () => {
    const home = tempHome()
    try {
      const stdin = fakeStdin()
      installFlightRecorder({ home, profile: 'sdk', pid: 6, stdin: stdin as never })
      stdin.emit('end')
      stdin.emit('error', new Error('EPIPE: broken pipe'))
      const rows = readFileSync(join(home, 'logs', 'runtime-flight-sdk-6.jsonl'), 'utf8').trim().split('\n')
        .map(line => JSON.parse(line) as Record<string, unknown>)
      expect(rows.at(-2)?.event).toBe('stdin_end')
      expect(rows.at(-1)?.event).toBe('stdin_error')
      expect(rows.at(-1)?.error).toBe('EPIPE: broken pipe')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('dispose detaches stdin listeners and restores the original stderr write', () => {
    const home = tempHome()
    try {
      const stdin = fakeStdin()
      const stderr = fakeStderr()
      const originalWrite = stderr.write
      const recorder = installFlightRecorder({ home, profile: 'sdk', pid: 7, stdin: stdin as never, stderr })
      recorder.dispose()
      expect(stderr.write).toBe(originalWrite)
      expect(stdin.listenerCount('end')).toBe(0)
      expect(stdin.listenerCount('error')).toBe(0)
      stdin.emit('end')
      const rows = readFileSync(join(home, 'logs', 'runtime-flight-sdk-7.jsonl'), 'utf8').trim().split('\n')
      expect(rows).toHaveLength(1) // boot row only — no post-dispose stdin_end
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
