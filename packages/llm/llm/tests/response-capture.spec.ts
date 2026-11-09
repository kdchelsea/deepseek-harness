import { describe, expect, it, vi } from 'vitest'
import { createResponseCapture } from '../src/response-capture.ts'
import type { LlmResponseBody } from '../src/types.ts'

describe('HTTP response capture', () => {
  it('preserves SSE framing and split UTF-8 without reading ahead', async () => {
    const text = ': heartbeat\r\ndata: {"text":"你好"}\r\n\r\ndata: [DONE]\r\n\r\n'
    const bytes = new TextEncoder().encode(text)
    let index = 0
    const publish = vi.fn()
    const capture = createResponseCapture(publish)
    const original = new Response(new ReadableStream({ pull(controller) {
      if (index === bytes.length) controller.close()
      else controller.enqueue(bytes.slice(index, ++index))
    } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } })
    const response = capture.wrap(original)
    expect(index).toBe(0)
    expect(await response.text()).toBe(text)
    await capture.flush()
    expect(publish).toHaveBeenCalledWith({ status: 200, contentType: 'text/event-stream', body: text, complete: true })
    await capture.flush()
    expect(publish).toHaveBeenCalledOnce()
  })

  it('retains error JSON and empty responses in HTTP attempt order', async () => {
    const publish = vi.fn()
    const capture = createResponseCapture(publish)
    await capture.wrap(new Response('{ "error": "busy" }', { status: 429 })).text()
    capture.wrap(new Response(null, { status: 204 }))
    await capture.flush()
    expect(publish.mock.calls.map(([body]) => body as LlmResponseBody)).toEqual([
      { status: 429, contentType: 'text/plain;charset=UTF-8', body: '{ "error": "busy" }', complete: true },
      { status: 204, contentType: '', body: '', complete: true },
    ])
  })

  it('marks cancelled and failed bodies as incomplete', async () => {
    for (const fail of [false, true]) {
      const publish = vi.fn()
      const capture = createResponseCapture(publish)
      let first = true
      const cancel = vi.fn()
      const response = capture.wrap(new Response(new ReadableStream({
        pull(controller) {
          if (first) { first = false; controller.enqueue(new TextEncoder().encode('prefix')) }
          else controller.error(new Error('connection lost'))
        }, cancel,
      }, { highWaterMark: 0 })))
      const reader = response.body!.getReader()
      await reader.read()
      if (fail) await expect(reader.read()).rejects.toThrow('connection lost')
      else { await reader.cancel(); expect(cancel).toHaveBeenCalledOnce() }
      await capture.flush()
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ body: 'prefix', complete: false }))
    }
  })

  it.each([3, 16])('keeps cancellation during a pending read distinct from EOF with budget %i', async (limit) => {
    const publish = vi.fn<(body: LlmResponseBody) => void>()
    const capture = createResponseCapture(publish, limit)
    const waiting = Promise.withResolvers<undefined>()
    const cancel = vi.fn()
    let first = true
    const original = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (first) {
          first = false
          controller.enqueue(new TextEncoder().encode('prefix'))
        } else waiting.resolve(undefined)
      },
      cancel,
    }, { highWaterMark: 0 }))
    const reader = capture.wrap(original).body!.getReader()
    expect((await reader.read()).value).toEqual(new TextEncoder().encode('prefix'))
    const pending = reader.read()
    await waiting.promise
    await reader.cancel('consumer stopped')
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(cancel).toHaveBeenCalledExactlyOnceWith('consumer stopped')
    expect(original.body!.locked).toBe(false)
    await capture.flush()
    expect(publish.mock.calls[0]?.[0]).toEqual({
      body: 'prefix'.slice(0, limit), status: 200, contentType: '', complete: false,
      ...limit < 6 ? { truncated: true } : {},
    })
  })

  it.each([1, 5, 6, 10])('bounds an oversized chunk at %i bytes without changing delivered bytes', async (limit) => {
    const publish = vi.fn<(body: LlmResponseBody) => void>()
    const capture = createResponseCapture(publish, limit)
    const bytes = new TextEncoder().encode('0123456789')
    const original = new Response(bytes, { status: 201, statusText: 'Created', headers: { 'x-test': 'retained' } })
    const response = capture.wrap(original)
    expect(response.status).toBe(201)
    expect(response.statusText).toBe('Created')
    expect(response.headers.get('x-test')).toBe('retained')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    await capture.flush()
    expect(publish.mock.calls[0]?.[0]).toEqual({
      status: 201, contentType: '', body: '0123456789'.slice(0, limit), complete: true,
      ...limit < 10 ? { truncated: true } : {},
    })
  })

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('keeps whole UTF-8 characters across one-byte chunks with budget %i', async (limit) => {
    const publish = vi.fn<(body: LlmResponseBody) => void>()
    const capture = createResponseCapture(publish, limit)
    const text = 'a你😀z'
    const bytes = new TextEncoder().encode(text)
    let index = 0
    const response = capture.wrap(new Response(new ReadableStream({ pull(controller) {
      if (index === bytes.length) controller.close()
      else controller.enqueue(bytes.slice(index, ++index))
    } }, { highWaterMark: 0 })))
    expect(index).toBe(0)
    expect(await response.text()).toBe(text)
    await capture.flush()
    const retained = publish.mock.calls[0]![0]
    expect(retained.body).toBe(limit < 4 ? 'a' : limit < 8 ? 'a你' : limit < 9 ? 'a你😀' : text)
    expect(new TextEncoder().encode(retained.body).length).toBeLessThanOrEqual(limit)
    expect(retained.truncated).toBe(limit < bytes.length ? true : undefined)
    expect(retained.complete).toBe(true)
  })

  it('shares the generation budget across replies without resetting on flush', async () => {
    const publish = vi.fn<(body: LlmResponseBody) => void>()
    const capture = createResponseCapture(publish, 7)
    for (const text of ['first', 'second', 'third']) expect(await capture.wrap(new Response(text)).text()).toBe(text)
    await capture.flush()
    expect(publish.mock.calls.map(([body]) => [body.body, body.complete, body.truncated])).toEqual([
      ['first', true, undefined], ['se', true, true], ['', true, true],
    ])
    expect(await capture.wrap(new Response('fourth')).text()).toBe('fourth')
    await capture.flush()
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({ body: '', complete: true, truncated: true })
  })

  it('reports truncation independently when consumption stops before EOF', async () => {
    const publish = vi.fn<(body: LlmResponseBody) => void>()
    const capture = createResponseCapture(publish, 3)
    const cancel = vi.fn()
    let reads = 0
    const reader = capture.wrap(new Response(new ReadableStream({
      pull(controller) { reads++; controller.enqueue(new TextEncoder().encode('prefix')) }, cancel,
    }, { highWaterMark: 0 }))).body!.getReader()
    expect(reads).toBe(0)
    expect((await reader.read()).value).toEqual(new TextEncoder().encode('prefix'))
    expect(reads).toBe(1)
    await reader.cancel('consumer stopped')
    await capture.flush()
    expect(cancel).toHaveBeenCalledExactlyOnceWith('consumer stopped')
    expect(publish.mock.calls[0]?.[0]).toMatchObject({ body: 'pre', complete: false, truncated: true })
  })

  it('bounds replacement text from malformed UTF-8 and preserves its input bytes', async () => {
    const publish = vi.fn<(body: LlmResponseBody) => void>()
    const capture = createResponseCapture(publish, 4)
    const bytes = Uint8Array.of(255, 255, 255, 255)
    expect(new Uint8Array(await capture.wrap(new Response(bytes)).arrayBuffer())).toEqual(bytes)
    await capture.flush()
    expect(publish.mock.calls[0]?.[0]).toMatchObject({ body: '�', complete: true, truncated: true })
  })

  it('disables preview publication and wrapping for a zero budget', async () => {
    const publish = vi.fn()
    const capture = createResponseCapture(publish, 0)
    const response = new Response('untouched')
    expect(capture.wrap(response)).toBe(response)
    expect(await response.text()).toBe('untouched')
    await capture.flush()
    expect(publish).not.toHaveBeenCalled()
  })

  it('leaves responses unchanged when capture is disabled', async () => {
    const capture = createResponseCapture()
    const response = new Response('untouched')
    expect(capture.wrap(response)).toBe(response)
    await capture.flush()
  })
})
