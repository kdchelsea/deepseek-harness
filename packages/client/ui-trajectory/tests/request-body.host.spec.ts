import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { registerRequestBody } from '../src/request-body.ts'

async function fixture(responseBody = false) {
  const ctx = new Context()
  let handle: ((request: Request) => Promise<Response>) | undefined
  const ref = { attachmentId: 'request', name: 'request.json', bytes: 1 }
  const readEvent = vi.fn(async () => ({ target: { type: responseBody ? 'trajectory/response' : 'trajectory/request', data: {
    content: [{ type: 'file', attachment: ref }], status: 429, contentType: 'text/plain', complete: false,
  } } }))
  const body = '{"messages":[{"role":"user","content":"你好"}],"max_tokens":42}'
  const readFileStream = vi.fn(async function* () {
    const bytes = new TextEncoder().encode(body)
    for (const byte of bytes) yield Uint8Array.of(byte)
  })
  ctx.provide('sessionQuery', { readEvent } as never)
  ctx.provide('attachments', { readFileStream } as never)
  ctx.provide('connection', { fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => {
    if (route.path === (responseBody ? '/api/trajectory.response-body' : '/api/trajectory.request-body')) handle = route.fetch
  } } } as never)
  const fiber = ctx.plugin({ apply: registerRequestBody })
  await fiber
  if (handle === undefined) throw new Error('missing request route')
  return { ctx, handle, readEvent, readFileStream, ref, body }
}

describe('request body route', () => {
  it('reads the Session-owned attachment and preserves split UTF-8 bytes', async () => {
    const { ctx, handle, readFileStream, ref, body } = await fixture()
    const request = new Request('http://localhost/api/trajectory.request-body?sessionId=s&seq=7')
    const response = await handle(request)
    expect(await response.text()).toBe(body)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(readFileStream).toHaveBeenCalledWith(ref, request.signal)
    await ctx.fiber.dispose()
  })

  it('returns raw response metadata and UTF-8 text from its Session reference', async () => {
    const { ctx, handle, body } = await fixture(true)
    const response = await handle(new Request('http://localhost/api/trajectory.response-body?sessionId=s&seq=7'))
    expect(await response.json()).toEqual({ body, status: 429, contentType: 'text/plain', complete: false })
    await ctx.fiber.dispose()
  })

  it.each(['', '?sessionId=s', '?sessionId=s&seq=-1', '?sessionId=s&seq=9007199254740992'])('rejects invalid coordinates: %s', async (query) => {
    const { ctx, handle, readEvent } = await fixture()
    expect((await handle(new Request(`http://localhost/api/trajectory.request-body${query}`))).status).toBe(400)
    expect(readEvent).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('refuses to read an attachment from an unrelated event', async () => {
    const { ctx, handle, readEvent, readFileStream } = await fixture()
    readEvent.mockResolvedValueOnce({ target: { type: 'turn/start', data: { content: [], status: 200, contentType: '', complete: true } } })
    expect((await handle(new Request('http://localhost/api/trajectory.request-body?sessionId=s&seq=0'))).status).toBe(404)
    expect(readFileStream).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})
