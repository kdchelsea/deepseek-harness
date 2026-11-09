/** Request metadata and bounded response bodies stored outside Session history. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { LlmRequestDiagnostics } from '@deepseek-ai/dsh-llm'
import { RequestTracker } from './tracker.ts'

/** Cordis plugin identity. */
export const name = 'llm-request-diagnostics'
/** This observer needs no runtime service injection. */
export const inject = []

/** Disk location, capture limits and progress-record cadence. */
export interface Config {
  /** Directory for private metadata and per-reply raw body files. */
  directory: string
  /** Milliseconds between progress snapshots; defaults to 5000. */
  progressIntervalMs: number
  /** Maximum bytes per metadata file, including reserved terminal records; defaults to 1 MiB. */
  maxFileBytes: number
  /** Total captured response bytes per invocation; defaults to 16 MiB, zero disables capture. */
  maxResponseBodyBytes: number
}

/** Validated deployment configuration. */
export const Config: z<Config> = z.object({
  directory: z.string().min(1).required(),
  progressIntervalMs: z.number().step(1).min(1).max(2_147_483_647).default(5000),
  maxFileBytes: z.number().step(1).min(8192).max(Number.MAX_SAFE_INTEGER).default(1_048_576),
  maxResponseBodyBytes: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(16_777_216),
})

/**
 * Register one observer provider and close its trackers on plugin disposal.
 * @param ctx - plugin lifecycle context.
 * @param config - diagnostic directory and progress interval.
 */
export function apply(ctx: Context, config: Config): void {
  const active = new Set<RequestTracker>()
  let disposed = false
  ctx.effect(() => () => {
    disposed = true
    for (const tracker of active) tracker.dispose()
    active.clear()
  }, 'llm-request-diagnostics: close request files and timers')
  ctx.on('llm/request-diagnostics', (options, next): LlmRequestDiagnostics | undefined => {
    const existing = next()
    if (existing !== undefined) {
      console.error('llm-request-diagnostics: duplicate observer refused; retaining the existing observer.')
      return existing
    }
    if (disposed) return undefined
    const tracker = new RequestTracker(options, config, subject => active.delete(subject))
    active.add(tracker)
    tracker.start()
    return tracker.observer
  })
}
