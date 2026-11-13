/**
 * Two-process EOF self-exit e2e host parent: spawns the kernel child with a
 * piped stdin (the transport face) and stays up only until SIGKILLed — it
 * never forwards signals, mirroring a crashed host. The child pid is printed
 * so the test can police a leftover.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CHILD = fileURLToPath(new URL('./eof-suicide-child.mjs', import.meta.url))
const [root, sessionId, exitCodeFile, grace] = process.argv.slice(2)
const child = spawn(process.execPath, [CHILD, root, sessionId, exitCodeFile], {
  stdio: ['pipe', 'inherit', 'inherit'],
  env: { ...process.env, DSH_SDK_EOF_EXIT_GRACE_MS: grace },
})
process.stdout.write(`child ${child.pid}\n`)
process.stdout.write('holding\n')
// Die only when killed; never exit on our own.
setInterval(() => {}, 1000)
