import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import * as trajectory from '../src/index.ts'

describe('provider request capture', () => {
  it('persists dispatched bodies only within an ordinary assistant attempt and unloads cleanly', async () => {
    const ctx = new Context()
    const sessions = ctx.plugin(SessionStore)
    await sessions
    const bytes = new Map<string, Uint8Array>()
    ctx.provide('attachments', {
      saveFile: async ({ data }: { data: Uint8Array }) => {
        bytes.set('request', data)
        return { attachmentId: 'request', name: 'request.json', bytes: data.length }
      },
    } as never)
    ctx.provide('connection', { fetch: { register: vi.fn() } } as never)
    ctx.provide('sessionQuery', {} as never)
    const plugin = ctx.plugin(trajectory)
    await plugin
    const session = ctx.sessions.create(SessionId('capture'))
    const agent = { session } as Agent
    const options = { provider: 'deepseek', model: 'm', messages: [], sessionId: session.id }
    const body = '{"model":"m","messages":[],"max_tokens":42}'
    const publish = (): Promise<void> => ctx.parallel('llm/request-body', options, body)
    await publish()
    expect(session.snapshotEvents()).toHaveLength(0)
    ctx.emit('agent/assistant-stream', { agent, frame: {
      type: 'start', turn: 2, step: 3, attemptId: LlmAttemptId('capture:1'), revision: 1,
    } })
    await ctx.parallel('llm/request-body', { ...options, purpose: 'session-title' }, body)
    await ctx.parallel('llm/request-body', { ...options, purpose: 'compaction' }, body)
    await ctx.parallel('llm/request-body', { provider: options.provider, model: options.model, messages: [] }, body)
    await publish()
    await publish()
    expect(new TextDecoder().decode(bytes.get('request'))).toBe(body)
    expect(session.snapshotEvents().map(event => event.data)).toEqual([
      { turn: 2, step: 3, content: [{ type: 'file', attachment: { attachmentId: 'request', name: 'request.json', bytes: body.length } }] },
      { turn: 2, step: 3, content: [{ type: 'file', attachment: { attachmentId: 'request', name: 'request.json', bytes: body.length } }] },
    ])
    expect(session.deriveMessages()).toEqual([])
    const response = { body: 'data: {"raw":"你好"}\r\n\r\n', status: 200, contentType: 'text/event-stream', complete: false }
    const aborted = new AbortController()
    aborted.abort()
    await ctx.parallel('llm/response-body', { ...options, signal: aborted.signal }, response)
    expect(session.snapshotEvents().at(-1)).toMatchObject({ type: 'trajectory/response', data: {
      turn: 2, step: 3, status: 200, contentType: 'text/event-stream', complete: false,
    } })
    expect(new TextDecoder().decode(bytes.get('request'))).toBe(response.body)
    expect(session.deriveMessages()).toEqual([])
    ctx.emit('agent/assistant-stream', { agent, frame: {
      type: 'end', attemptId: LlmAttemptId('capture:1'), revision: 2, index: 0,
      outcome: { kind: 'abandoned' },
    } })
    await publish()
    expect(session.snapshotEvents()).toHaveLength(3)
    ctx.emit('agent/assistant-stream', { agent, frame: {
      type: 'start', turn: 2, step: 4, attemptId: LlmAttemptId('capture:2'), revision: 3,
    } })
    ctx.emit('agent/disposed', { agent })
    await publish()
    expect(session.snapshotEvents()).toHaveLength(3)
    await plugin.dispose()
    await publish()
    expect(session.snapshotEvents()).toHaveLength(3)
    await sessions.dispose()
  })
})
