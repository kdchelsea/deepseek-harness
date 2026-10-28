/** Capture provider request bodies for the trajectory inspector. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-session-query'
import { registerRequestBody } from './request-body.ts'

/** Services for durable body storage and authenticated historical reads. */
export const inject = ['attachments', 'connection', 'sessionQuery']

/**
 * Install request capture for ordinary assistant attempts.
 * @param ctx - plugin context owning capture listeners.
 */
export function apply(ctx: Context): void {
  registerRequestBody(ctx)
  const active = new Map<SessionId, { agent: Agent; turn: number; step: number }>()
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type === 'start') active.set(agent.session.id, { agent, turn: frame.turn, step: frame.step })
    else if (frame.type === 'end') active.delete(agent.session.id)
  }, { global: true })
  ctx.on('agent/disposed', ({ agent }) => { active.delete(agent.session.id) }, { global: true })
  ctx.on('llm/request-body', async (options, body) => {
    if (options.sessionId === undefined || options.purpose !== undefined) return
    const attempt = active.get(options.sessionId)
    if (attempt === undefined) return
    const ref = await ctx.attachments.saveFile({ data: new TextEncoder().encode(body), name: 'request.json' })
    options.signal?.throwIfAborted()
    if (active.get(options.sessionId) !== attempt) return
    attempt.agent.session.append('trajectory/request', { turn: attempt.turn, step: attempt.step, content: [{ type: 'file', attachment: ref }] })
  }, { global: true })
  ctx.on('llm/response-body', async (options, response) => {
    if (options.sessionId === undefined || options.purpose !== undefined) return
    const attempt = active.get(options.sessionId)
    if (attempt === undefined) return
    const { body, ...metadata } = response
    const ref = await ctx.attachments.saveFile({ data: new TextEncoder().encode(body), name: 'response.txt' })
    if (active.get(options.sessionId) !== attempt) return
    attempt.agent.session.append('trajectory/response', {
      turn: attempt.turn, step: attempt.step, ...metadata, content: [{ type: 'file', attachment: ref }],
    })
  }, { global: true })
  ctx.effect(() => () => { active.clear() })
}
