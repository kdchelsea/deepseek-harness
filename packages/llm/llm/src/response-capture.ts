/** Capture HTTP response bytes as consumed, before provider parsing. */
import type { LlmResponseBody } from './types.ts'

/** Default aggregate response-preview budget for one generation (16 MiB). */
export const DEFAULT_RESPONSE_CAPTURE_MAX_BYTES = 16 * 1024 * 1024

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
 * @param maxBytes - non-negative safe integer bounding aggregate preview bytes across replies;
 * defaults to 16 MiB. Zero disables capture. A cut discards any trailing partial UTF-8 character.
 * @returns body wrapper and awaited finalizer owned by the adapter.
 */
export function createResponseCapture(
  publish?: (body: LlmResponseBody) => void | Promise<void>, maxBytes = DEFAULT_RESPONSE_CAPTURE_MAX_BYTES,
): ResponseCapture {
  const responses: Array<{ response: LlmResponseBody; decoder: TextDecoder }> = []
  // Invalid UTF-8 can expand into replacement characters; bound input and decoded text separately.
  let remainingInput = maxBytes
  let remainingText = maxBytes
  const encoder = new TextEncoder()
  const append = (response: LlmResponseBody, text: string): void => {
    const bytes = encoder.encode(text)
    if (bytes.length > remainingText) {
      text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(0, remainingText), { stream: true })
      response.truncated = true
    }
    remainingText -= response.truncated === true ? encoder.encode(text).length : bytes.length
    response.body += text
  }
  return {
    wrap(response) {
      if (publish === undefined || maxBytes === 0) return response
      const entry: { response: LlmResponseBody; decoder: TextDecoder } = {
        response: { status: response.status, contentType: response.headers.get('content-type') ?? '', body: '', complete: response.body === null },
        decoder: new TextDecoder('utf-8', { ignoreBOM: true }),
      }
      responses.push(entry)
      if (response.body === null) return response
      const reader = response.body.getReader()
      let cancelled = false
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read()
            if (cancelled) return
            if (chunk.done) {
              entry.response.complete = true
              reader.releaseLock()
              controller.close()
            } else {
              if (entry.response.truncated !== true) {
                const size = Math.min(chunk.value.byteLength, remainingInput)
                remainingInput -= size
                append(entry.response, entry.decoder.decode(chunk.value.subarray(0, size), { stream: true }))
                if (size < chunk.value.byteLength) entry.response.truncated = true
              }
              controller.enqueue(chunk.value)
            }
          } catch (error) {
            reader.releaseLock()
            controller.error(error)
          }
        },
        async cancel(reason) {
          cancelled = true
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
        if (entry.response.truncated !== true) append(entry.response, entry.decoder.decode())
        await publish?.(entry.response)
      }
    },
  }
}
