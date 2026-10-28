/** Read provider request bodies captured at dispatch, without reconstructing them. */
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { REQUEST_BODY_PATH } from '../request.ts'

/** Parsed provider JSON; fields are owned by the selected provider. */
export type TrajectoryRequestInput = Record<string, unknown>

/** On-demand history read; null means no provider request body was recorded. */
export type LoadRequestInput = (turn: number, step: number, signal: AbortSignal) => Promise<TrajectoryRequestInput | null>

/**
 * Locate the last dispatched provider body for one ordinary request step.
 * @param entries - complete Session history.
 * @param turn - owning turn.
 * @param step - owning step.
 * @returns captured request event sequence, or null for requests without capture.
 */
export function inspectRequestInput(
  entries: readonly SessionEventLikeEntry[],
  turn: number,
  step: number,
): SessionSeq | null {
  const entry = entries.findLast(({ event }) => event.type === 'trajectory/request'
    && event.data.turn === turn && event.data.step === step)
  return entry === undefined ? null : entry.event.seq as SessionSeq
}

/**
 * Fetch the exact provider JSON referenced by a durable request event.
 * @param sessionId - owning Session.
 * @param seq - request event sequence.
 * @param signal - inspector lifetime.
 * @returns parsed provider request fields.
 */
export async function readRequestInput(sessionId: SessionId, seq: SessionSeq, signal: AbortSignal): Promise<TrajectoryRequestInput> {
  const query = new URLSearchParams({ sessionId, seq: String(seq) })
  const response = await fetch(`${REQUEST_BODY_PATH}?${query}`, { signal })
  if (!response.ok) throw new Error('Provider request body could not be loaded')
  const body: unknown = await response.json()
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Recorded provider request body is not a JSON object')
  }
  return body as TrajectoryRequestInput
}
