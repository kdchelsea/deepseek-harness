import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent, SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { inspectRequestInput, readRequestInput } from '../src/client/request-input.ts'

function entry(seq: number, turn: number, step: number): SessionEventLikeEntry {
  return { type: 'event', event: {
    seq, type: 'trajectory/request', time: 0, data: { turn, step, content: [] },
  } as unknown as SessionEvent }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('provider request inspection', () => {
  it('selects the last dispatch of the requested step', () => {
    const entries = [entry(1, 1, 1), entry(2, 1, 1), entry(3, 1, 2), entry(4, 2, 1)]
    expect(inspectRequestInput(entries, 1, 1)).toBe(2)
    expect(inspectRequestInput(entries, 3, 1)).toBeNull()
  })

  it('does not reconstruct API requests from old headers', () => {
    const entries = [{ type: 'event', event: { type: 'request/header', seq: 0, time: 0,
      data: { header: { config: { provider: 'deepseek', model: 'old' } }, reason: 'initial' },
    } } as SessionEventLikeEntry]
    expect(inspectRequestInput(entries, 1, 1)).toBeNull()
  })

  it('loads provider fields using Session event coordinates and the inspector signal', async () => {
    const body = { model: 'm', messages: [], max_tokens: 42, extension: { retained: true } }
    const fetcher = vi.fn(async () => Response.json(body))
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    expect(await readRequestInput('s' as SessionId, 7 as SessionSeq, signal)).toEqual(body)
    expect(fetcher).toHaveBeenCalledWith('/api/trajectory.request-body?sessionId=s&seq=7', { signal })
  })

  it.each(['null', '[]', '"string"', '{broken'])('rejects an invalid recorded body: %s', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    await expect(readRequestInput('s' as SessionId, 0 as SessionSeq, new AbortController().signal)).rejects.toThrow()
  })

  it('rejects a failed body read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    await expect(readRequestInput('s' as SessionId, 0 as SessionSeq, new AbortController().signal)).rejects.toThrow()
  })
})
