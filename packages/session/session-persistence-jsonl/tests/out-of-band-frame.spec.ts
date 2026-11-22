import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId, SESSION_FORMAT_VERSION, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { eventLines, logPath, toHeaderLine } from '../src/format.ts'
import { compressZstdFrame, decompressZstdFrame, scanZstdFrames } from '../src/zstd.ts'
import { oneTurnLog } from '../../session-persistence/tests/contract.ts'

const roots: string[] = []
const contexts: Context[] = []

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-out-of-band-'))
  roots.push(root)
  return root
}

async function mount(root: string): Promise<SessionPersistence> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
  return ctx.sessionPersistence
}

function header(id: string): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1000, isSeeded: false }
}

/** The first event of a fresh turn after {@link oneTurnLog}'s closed turn. */
function secondTurnStart(seq: number): SessionEvent {
  return { type: 'turn/start', seq: SessionSeq(seq), time: 7, data: { turn: 2 } }
}

/** Create + append + close: persist one whole healthy log through the write handle. */
async function writeLog(persistence: SessionPersistence, m: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
  const handle = await persistence.create(m)
  try {
    await handle.append(events)
  } finally {
    await handle.close()
  }
}

/** Decode every complete frame of one artifact into its plaintext chunks. */
async function framePlaintexts(bytes: Buffer): Promise<Buffer[]> {
  const { frames } = scanZstdFrames(bytes)
  return Promise.all(frames.map(frame => decompressZstdFrame(bytes.subarray(frame.start, frame.end))))
}

/** The artifact's physical JSONL text, one plaintext chunk per frame joined. */
async function artifactText(bytes: Buffer): Promise<string> {
  return Buffer.concat(await framePlaintexts(bytes)).toString('utf8')
}

function headerLineOf(m: SessionHeader): string {
  return `${JSON.stringify(toHeaderLine(m))}\n`
}

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('decodable out-of-band first frames', () => {
  it('reads a packed single-frame artifact and reframes it canonically on the first append', async () => {
    const root = await freshRoot()
    const persistence = await mount(root)
    const m = header('packed-first-frame')
    const turn = oneTurnLog()
    await writeLog(persistence, m, turn)

    const path = logPath(root, undefined, m.id, 'zstd')
    // An out-of-band writer that ignores the frame discipline packs the header
    // and the whole first batch into one physical frame. Structurally valid
    // Zstandard, semantically intact JSONL — the reader must not brick the
    // session on it, and metadata discovery must still name the session.
    const packed = await compressZstdFrame(Buffer.from(`${headerLineOf(m)}${eventLines(turn)}\n`))
    await writeFile(path, packed)

    const snapshot = await persistence.stat(m.id)
    expect(snapshot?.header.id).toBe(m.id)
    const listed = await persistence.list()
    expect(listed.map(item => item.header.id)).toEqual([m.id])

    // A read-only open never mutates the artifact (opens stay fail-closed pure).
    const readHandle = await persistence.open(m.id, 'read')
    try {
      expect((await readHandle.read()).events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5])
    } finally {
      await readHandle.close()
    }
    expect((await readFile(path)).equals(packed)).toBe(true)

    // The first mutation reframes this exact artifact into canonical frames.
    const writeHandle = await persistence.open(m.id, 'write')
    try {
      expect((await writeHandle.read()).events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5])
      await writeHandle.append([secondTurnStart(6)])
    } finally {
      await writeHandle.close()
    }

    const reframed = await readFile(path)
    const chunks = await framePlaintexts(reframed)
    expect(chunks).toHaveLength(3)
    // Frame zero carries exactly the header record and nothing else.
    expect(chunks[0]!.toString('utf8')).toBe(headerLineOf(m))
    expect(await artifactText(reframed))
      .toBe(`${headerLineOf(m)}${eventLines(turn)}\n${eventLines([secondTurnStart(6)])}\n`)

    const replay = await persistence.open(m.id, 'read')
    try {
      expect((await replay.read()).events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6])
    } finally {
      await replay.close()
    }
  })

  it('leaves a canonical artifact byte-identical across opens and keeps appends canonical', async () => {
    const root = await freshRoot()
    const persistence = await mount(root)
    const m = header('canonical-untouched')
    const turn = oneTurnLog()
    await writeLog(persistence, m, turn)

    const path = logPath(root, undefined, m.id, 'zstd')
    const before = await readFile(path)
    expect((await framePlaintexts(before)).map(chunk => chunk.toString('utf8'))).toEqual([
      headerLineOf(m),
      `${eventLines(turn)}\n`,
    ])

    for (const access of ['read', 'write'] as const) {
      const handle = await persistence.open(m.id, access)
      try {
        expect((await handle.read()).events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5])
      } finally {
        await handle.close()
      }
    }
    expect((await readFile(path)).equals(before)).toBe(true)

    const appendHandle = await persistence.open(m.id, 'write')
    try {
      await appendHandle.append([secondTurnStart(6)])
    } finally {
      await appendHandle.close()
    }
    const after = await readFile(path)
    expect((await framePlaintexts(after))[0]!.toString('utf8')).toBe(headerLineOf(m))
    expect(await artifactText(after))
      .toBe(`${headerLineOf(m)}${eventLines(turn)}\n${eventLines([secondTurnStart(6)])}\n`)
  })
})

describe('corruption stays a corruption', () => {
  async function corruptArtifact(
    persistence: SessionPersistence,
    root: string,
    m: SessionHeader,
    bytes: Buffer,
  ): Promise<Error> {
    await writeLog(persistence, m, oneTurnLog())
    await writeFile(logPath(root, undefined, m.id, 'zstd'), bytes)
    return persistence.open(m.id, 'read').then(() => {
      throw new Error('expected the corrupt artifact to be refused')
    }, (error: unknown) => error as Error)
  }

  it('refuses a first frame without a header line and names the frame contract', async () => {
    const root = await freshRoot()
    const persistence = await mount(root)
    const m = header('no-header-newline')
    const error = await corruptArtifact(
      persistence,
      root,
      m,
      await compressZstdFrame(Buffer.from(JSON.stringify(toHeaderLine(m)))),
    )
    expect(error).toBeInstanceOf(SessionPersistenceCorruptionError)
    expect(error.message).toContain('first frame is not exactly one header line')
  })

  it('refuses a first frame whose leading record is not a session header', async () => {
    const root = await freshRoot()
    const persistence = await mount(root)
    const m = header('leading-event')
    const error = await corruptArtifact(
      persistence,
      root,
      m,
      await compressZstdFrame(Buffer.from(`${eventLines(oneTurnLog().slice(0, 1))}\n`)),
    )
    expect(error).toBeInstanceOf(SessionPersistenceCorruptionError)
    expect(error.message).toContain('first line is not a session header')
  })

  it('refuses records packed behind the header when they cannot be parsed', async () => {
    const root = await freshRoot()
    const persistence = await mount(root)
    const m = header('packed-garbage-record')
    const error = await corruptArtifact(
      persistence,
      root,
      m,
      await compressZstdFrame(Buffer.from(`${headerLineOf(m)}not json\n`)),
    )
    expect(error).toBeInstanceOf(SessionPersistenceCorruptionError)
    expect(error.message).toContain('complete frame contains a torn JSONL record')
  })

  it('refuses undecodable bytes and empty artifacts', async () => {
    const root = await freshRoot()
    const persistence = await mount(root)
    const m = header('garbage-bytes')
    const garbage = await corruptArtifact(persistence, root, m, Buffer.from('definitely not a Zstandard frame'.repeat(4)))
    expect(garbage).toBeInstanceOf(SessionPersistenceCorruptionError)

    const empty = header('empty-artifact')
    const emptyError = await corruptArtifact(persistence, root, empty, Buffer.alloc(0))
    expect(emptyError).toBeInstanceOf(SessionPersistenceCorruptionError)
    expect(emptyError.message).toContain('empty or header-less')
  })
})
