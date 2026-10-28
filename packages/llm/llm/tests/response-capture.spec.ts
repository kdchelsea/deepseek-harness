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

  it('leaves responses unchanged when capture is disabled', async () => {
    const capture = createResponseCapture()
    const response = new Response('untouched')
    expect(capture.wrap(response)).toBe(response)
    await capture.flush()
  })
})
