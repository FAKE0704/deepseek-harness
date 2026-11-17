/**
 * Turn-boundary residual-range reaper (K12).
 *
 * A command that backgrounds work and exits (`python job.py &`, `nohup … &`,
 * a daemonizing helper) leaves its managed range populated after the spawned
 * command settles: the range is still active with descendants only. Before
 * this plugin such a range stayed owned until the whole runtime disposed, so a
 * finished run (a turn) could leave a long-lived child behind — the 2026-11-17
 * orphan form where a 1.09 GB python process kept burning swap for hours
 * after its run ended, and the 2026-11-15 host restart preceded by an orphan
 * build.
 *
 * This plugin is the lifecycle policy, kept out of the provider: it observes
 * the durable `turn/end` boundary (normal completion, error, timeout and
 * abort all append it) and asks a local provider to terminate exactly the
 * ranges whose spawned command already settled. A direct process that is
 * still running is service work (language server, in-flight command) and is
 * never touched. Load it as its own row so a deployment that needs
 * cross-turn background processes can omit the row instead of configuring a
 * switch.
 *
 * @module @deepseek-ai/dsh-subprocess-local/turn-reaper
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

export const name = 'subprocess-turn-reaper'
export const inject = ['subprocess']

/** Capability the local provider adds for this lifecycle policy; other providers stay untouched. */
interface SettledRangeReaper {
  reapSettledRanges(): Promise<number>
}

/**
 * Reap settled-direct managed ranges whenever a turn closes.
 * @param ctx - plugin context owning the subprocess service.
 */
export function apply(ctx: Context): void {
  ctx.on('session/event', (_session, event) => {
    if (event.type !== 'turn/end') return
    const runtime = ctx.subprocess as SubprocessRuntime & Partial<SettledRangeReaper>
    if (typeof runtime.reapSettledRanges !== 'function') return
    void runtime.reapSettledRanges().catch((error: unknown) => {
      ctx.logger.warn(`subprocess-turn-reaper: residual range reaping failed: ${String(error)}`)
    })
  })
}
