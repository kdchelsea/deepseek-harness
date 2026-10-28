import { describe, expect, it } from 'vitest'
import { presentResponseBody } from '../src/client/response-presentation.ts'

describe('structured response projection', () => {
  it('decodes provider JSON without changing the original text', () => {
    const body = '{ "response": {"id":"r1", "output":[]} }'
    expect(presentResponseBody(body, 'application/json')).toEqual({ kind: 'json', data: { response: { id: 'r1', output: [] } } })
    expect(body).toBe('{ "response": {"id":"r1", "output":[]} }')
  })

  it('retains SSE event order, ids, multiline data, provider types and the end marker', () => {
    const body = '\uFEFF: keepalive\r\nevent: response.created\r\nid: 17\r\ndata: {"response":\r\ndata: {"id":"r1"}}\r\n\r\n'
      + 'data: {"type":"response.output_text.delta","delta":"你好"}\n\n'
      + 'data: [DONE]\n\n'
      + 'event: unfinished\ndata: {"partial":'
    expect(presentResponseBody(body, 'text/event-stream; charset=utf-8')).toEqual({ kind: 'sse', events: [
      { name: 'response.created', id: '17', data: { response: { id: 'r1' } } },
      { name: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: '你好' } },
      { name: '[DONE]', data: { data: '[DONE]' } },
    ] })
  })

  it('keeps malformed event payloads and plain text readable', () => {
    expect(presentResponseBody('event: error\ndata: {bad json}\n\n', 'text/event-stream')).toEqual({
      kind: 'sse', events: [{ name: 'error', data: { data: '{bad json}' } }],
    })
    expect(presentResponseBody('<html>gateway error</html>', 'text/html')).toEqual({ kind: 'text' })
    expect(presentResponseBody('data: {"partial":', 'text/event-stream')).toEqual({ kind: 'text' })
    expect(presentResponseBody('null', 'application/json')).toEqual({ kind: 'json', data: { data: null } })
  })
})
