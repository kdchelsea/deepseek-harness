/** Capture HTTP response bytes as consumed, before provider parsing. */
import type { LlmResponseBody } from './types.ts'

/** Per-generation response capture; one entry per HTTP response, including retries. */
export interface ResponseCapture {
  /**
   * Wrap the body without reading ahead or changing bytes delivered to the SDK.
   * @param response - original fetch response.
   * @returns response with an observed body, or the original when capture is disabled.
   */
  wrap(response: Response): Response
  /** Persist received prefixes after the provider consumer has stopped. */
  flush(): Promise<void>
}

/**
 * Create an isolated response observer for one generation.
 * @param publish - receives decoded HTTP bodies without parsing SSE or JSON; absent disables capture.
 * @returns body wrapper and awaited finalizer owned by the adapter.
 */
export function createResponseCapture(publish?: (body: LlmResponseBody) => void | Promise<void>): ResponseCapture {
  const responses: Array<{ response: LlmResponseBody; decoder: TextDecoder }> = []
  return {
    wrap(response) {
      if (publish === undefined) return response
      const entry = {
        response: { status: response.status, contentType: response.headers.get('content-type') ?? '', body: '', complete: response.body === null },
        decoder: new TextDecoder('utf-8', { ignoreBOM: true }),
      }
      responses.push(entry)
      if (response.body === null) return response
      const reader = response.body.getReader()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read()
            if (chunk.done) {
              entry.response.complete = true
              reader.releaseLock()
              controller.close()
            } else {
              entry.response.body += entry.decoder.decode(chunk.value, { stream: true })
              controller.enqueue(chunk.value)
            }
          } catch (error) {
            reader.releaseLock()
            controller.error(error)
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason)
          } finally {
            reader.releaseLock()
          }
        },
      }, { highWaterMark: 0 })
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    },
    async flush() {
      for (const entry of responses.splice(0)) {
        entry.response.body += entry.decoder.decode()
        await publish?.(entry.response)
      }
    },
  }
}
