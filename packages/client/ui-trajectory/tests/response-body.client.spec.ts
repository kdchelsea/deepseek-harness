import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { readResponseBodies } from '../src/client/response-body.ts'

const entries = [1, 2, 3].map(seq => ({ type: 'event', event: {
  type: 'trajectory/response', seq, time: 0, data: { turn: 1, step: seq === 3 ? 2 : 1, content: [], status: 200, complete: true, contentType: '' },
} })) as unknown as readonly SessionEventLikeEntry[]
afterEach(() => { vi.unstubAllGlobals() })

describe('raw response reads', () => {
  it('reads only the selected step and preserves HTTP attempt order', async () => {
    const body = { status: 200, body: 'data: [DONE]\n\n', contentType: 'text/event-stream', complete: true }
    const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => Response.json(body))
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    expect(await readResponseBodies('s' as SessionId, entries, 1, 1, signal)).toEqual([body, body])
    expect(fetcher.mock.calls.map(args => args[0])).toEqual([
      '/api/trajectory.response-body?sessionId=s&seq=1', '/api/trajectory.response-body?sessionId=s&seq=2',
    ])
    expect(await readResponseBodies('s' as SessionId, entries, 9, 1, signal)).toEqual([])
  })

  it.each(['null', '{}', '{"body":1}', '[]'])('rejects malformed saved response %s', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    await expect(readResponseBodies('s' as SessionId, entries, 1, 1, new AbortController().signal)).rejects.toThrow('invalid')
  })

  it('reports an unsuccessful attachment read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    await expect(readResponseBodies('s' as SessionId, entries, 1, 1, new AbortController().signal)).rejects.toThrow('could not be loaded')
  })
})
