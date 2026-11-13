/**
 * Two-process EOF self-exit e2e kernel child: mounts the real JSON-RPC plugin
 * over the real process stdio face (no input/output overrides) while holding
 * the session write lock. The parent transport face is this process's piped
 * stdin; when it dies, the bounded self-exit must end this process with code
 * 0 inside the grace-plus-deadline window. Runs the built package under plain
 * Node.
 */

import { writeFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SdkJsonRpcServer from '@deepseek-ai/dsh-sdk-jsonrpc-server'

const [root, sessionId, exitCodeFile] = process.argv.slice(2)
const ctx = new Context()
// The EOF self-exit never touches the agent face; a stub satisfies the
// plugin's declared injection without mounting the full agent loop.
ctx.provide('agents', {})
await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
const handle = await ctx.sessionPersistence.create({
  version: SESSION_FORMAT_VERSION,
  id: sessionId,
  createdAt: 1000,
  cwd: '/work',
  isSeeded: false,
})
await handle.append([
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
])
await ctx.plugin(SdkJsonRpcServer, {
  // The real process.exit still runs; the file records the code because the
  // test process cannot observe a non-child's exit event.
  exit: (code) => {
    writeFileSync(exitCodeFile, String(code))
    process.exit(code)
  },
})
process.stdout.write('holding\n')
