/** Load original provider response text through authenticated Session references. */
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { LlmResponseBody } from '@deepseek-ai/dsh-llm/types'
import { RESPONSE_BODY_PATH } from '../request.ts'

/** On-demand raw HTTP response history for one ordinary generation step. */
export type LoadResponseBodies = (turn: number, step: number, signal: AbortSignal) => Promise<readonly LlmResponseBody[]>

/**
 * Read every recorded HTTP response for a step, retaining retry order.
 * @param sessionId - owning Session.
 * @param entries - complete loaded Session history.
 * @param turn - owning turn.
 * @param step - owning step.
 * @param signal - inspector lifetime.
 * @returns raw response bodies, empty when none were recorded.
 */
export async function readResponseBodies(
  sessionId: SessionId, entries: readonly SessionEventLikeEntry[], turn: number, step: number, signal: AbortSignal,
): Promise<readonly LlmResponseBody[]> {
  const result: LlmResponseBody[] = []
  for (const { event } of entries) {
    if (event.type !== 'trajectory/response' || event.data.turn !== turn || event.data.step !== step) continue
    const query = new URLSearchParams({ sessionId, seq: String(event.seq) })
    const response = await fetch(`${RESPONSE_BODY_PATH}?${query}`, { signal })
    if (!response.ok) throw new Error('Provider response body could not be loaded')
    const value: unknown = await response.json()
    if (value === null || typeof value !== 'object'
      || !('body' in value) || typeof value.body !== 'string'
      || !('status' in value) || typeof value.status !== 'number'
      || !('contentType' in value) || typeof value.contentType !== 'string'
      || !('complete' in value) || typeof value.complete !== 'boolean') {
      throw new Error('Recorded provider response is invalid')
    }
    result.push({ body: value.body, status: value.status, contentType: value.contentType, complete: value.complete })
  }
  return result
}
