/** Progress and bounded HTTP response observation for one model call. */
import type { GenerateOptions, StreamChunk } from './types.ts'

/** Terminal state of a model-call observation; independent of task success. */
export type LlmRequestDiagnosticOutcome = 'completed' | 'error' | 'aborted' | 'consumer-stopped'

/** Per-call observer; logging failures are contained while fetch preserves transport failures. */
export interface LlmRequestDiagnostics {
  /** Fetch with the same transport semantics; may retain a bounded consumed response prefix. */
  fetch: typeof globalThis.fetch
  /**
   * Observe one provider-neutral chunk without retaining its content.
   * @param chunk - chunk delivered by the adapter before the consumer sees it.
   */
  chunk(chunk: StreamChunk): void
  /**
   * Close the observation after adapter cleanup; repeated calls have no effect.
   * @param outcome - model-call completion, failure, cancellation, or consumer return.
   * @param errorCode - machine failure code when available; never an error message.
   */
  finish(outcome: LlmRequestDiagnosticOutcome, errorCode?: string): void
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Create a progress and bounded response observer for one adapter invocation, including retries.
     * Listeners must call next(); the default supplies no observer. Observation
     * must not change model output or propagate logging failures into the call.
     * @mode waterfall
     * @param options - request attribution; message and tool content must not be logged.
     * @param next - delegate to the next observer provider.
     * @returns observer owned by this invocation, or undefined when disabled.
     */
    'llm/request-diagnostics'(options: GenerateOptions<string>, next: () => LlmRequestDiagnostics | undefined): LlmRequestDiagnostics | undefined
  }
}

/**
 * Observe parsed chunks and settle diagnostics after the adapter iterator closes.
 * @param options - request whose signal distinguishes caller cancellation.
 * @param diagnostics - per-call observer, or undefined for ordinary pass-through.
 * @param stream - adapter iterator; values, exceptions, and consumer return are preserved.
 * @returns the original model chunks without additional model-visible content.
 */
export async function* withRequestDiagnostics(
  options: GenerateOptions<string>,
  diagnostics: LlmRequestDiagnostics | undefined,
  stream: AsyncIterable<StreamChunk>,
): AsyncGenerator<StreamChunk> {
  let outcome: LlmRequestDiagnosticOutcome = 'consumer-stopped'
  let errorCode: string | undefined
  try {
    for await (const chunk of stream) {
      diagnostics?.chunk(chunk)
      if (chunk.type === 'finish') {
        outcome = chunk.reason.kind === 'error' ? 'error'
          : chunk.reason.kind === 'aborted' ? 'aborted' : 'completed'
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') errorCode = chunk.reason.failure.code
      }
      yield chunk
    }
    if (outcome === 'consumer-stopped') outcome = 'completed'
  } catch (error: unknown) {
    outcome = options.signal?.aborted ? 'aborted' : 'error'
    if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
      errorCode = error.code
    }
    throw error
  } finally {
    diagnostics?.finish(options.signal?.aborted ? 'aborted' : outcome, errorCode)
  }
}
