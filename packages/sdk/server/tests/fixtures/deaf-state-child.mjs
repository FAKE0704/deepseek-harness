/**
 * Two-process parked-approval deafness e2e kernel child (132号 incident
 * shape): hand-builds a cordis context that mounts the real JSON-RPC plugin
 * over the REAL process stdio face (no input/output overrides) beside a test
 * plugin whose effect disposer never settles. On `shutdown` the plugin's exit
 * task flushes, starts the root disposal — transport.close() runs (cordis
 * unloads child fibers concurrently, so the hung sibling disposer does not
 * block it) — and the hung disposer keeps rootFiber.dispose() pending forever,
 * making exit(0) unreachable: the process stays alive and deaf until SIGTERM.
 * Runs the built package under plain Node.
 */

import { Context } from '@deepseek-ai/cordis'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SdkJsonRpcServer from '@deepseek-ai/dsh-sdk-jsonrpc-server'

const [root] = process.argv.slice(2)
const ctx = new Context()
// The plugin's declared injection: the approval deafness repro never drives
// the agent face, so a stub satisfies it without the full agent loop.
ctx.provide('agents', {})
await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
// The real approval seam, as in production: approval-respond resolves through
// the approval service (here: "no pending approval <id>" errors for unknown ids).
await ctx.plugin(ApprovalService)
// The hung-disposal witness: its effect disposer never settles, so the root
// disposal — and therefore the plugin's exitOnce(0) — stays pending forever
// while the process lives on.
const hungDisposalPlugin = (inner) => {
  inner.effect(() => () => new Promise(() => {}), 'deaf-state hung disposal witness')
}
await ctx.plugin(hungDisposalPlugin)
await ctx.plugin(SdkJsonRpcServer, {})
// Signal exits stay owned by the app bin; this fixture owns SIGTERM → exit 0.
process.on('SIGTERM', () => { process.exit(0) })
process.stdout.write('serving\n')
// Keep-alive beat: the loop must never drain while the process is deaf.
setInterval(() => {}, 1000)
