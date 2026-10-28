/** Read-only projections of saved HTTP bodies; the original text remains authoritative. */
import { createParser } from 'eventsource-parser'

/** A complete SSE event with its optional wire id and decoded data. */
export interface ResponseEvent {
  name: string
  id?: string
  data: object
}

/** Structured JSON, complete SSE events, or an unparsed text body. */
export type ResponsePresentation =
  | { kind: 'json'; data: object }
  | { kind: 'sse'; events: readonly ResponseEvent[] }
  | { kind: 'text' }

function treeData(value: unknown): object {
  return value !== null && typeof value === 'object' ? value : { data: value }
}

/**
 * Project JSON or complete SSE events without modifying saved response text.
 * @param body - original HTTP response text.
 * @param contentType - recorded Content-Type header.
 * @returns decoded fields, or a text fallback; unfinished SSE frames remain in the original text.
 */
export function presentResponseBody(body: string, contentType: string): ResponsePresentation {
  if (contentType.split(';')[0]?.trim().toLowerCase() === 'text/event-stream') {
    const events: ResponseEvent[] = []
    const parser = createParser({ onEvent(event) {
      let value: unknown = event.data
      try {
        value = JSON.parse(event.data)
      } catch {
        // SSE data may be plain text, including the provider's [DONE] sentinel.
      }
      const type = value !== null && typeof value === 'object' && 'type' in value && typeof value.type === 'string'
        ? value.type : event.data === '[DONE]' ? '[DONE]' : 'message'
      events.push({ name: event.event ?? type, ...event.id === undefined ? {} : { id: event.id }, data: treeData(value) })
    } })
    parser.feed(body)
    return events.length === 0 ? { kind: 'text' } : { kind: 'sse', events }
  }
  try {
    return { kind: 'json', data: treeData(JSON.parse(body)) }
  } catch {
    // Error pages and incomplete JSON remain available as the received text.
    return { kind: 'text' }
  }
}
