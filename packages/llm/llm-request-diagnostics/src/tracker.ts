/** Synchronous metadata and bounded raw response files observed on consumer demand. */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { join } from 'node:path'
import type { GenerateOptions, LlmRequestDiagnosticOutcome, LlmRequestDiagnostics, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Config } from './index.ts'

type Metadata = Record<string, string | number | boolean | null>

interface BodyFile {
  httpId: number
  file: string | null
  fd: number | undefined
  consumedBytes: number
  writtenBytes: number
  captureError: 'open' | 'write' | 'close' | null
}

type BodyEnd = 'eof' | 'error' | 'cancel' | 'unfinished'

// Each admitted body reserves its compact end record, even after progress truncation.
const BODY_END_RESERVE = 1024
const TERMINAL_RESERVE = 4096

/** Accept only bounded machine identifiers, never free-form error text. */
function diagnosticCode(code?: string): string | null {
  return code === undefined ? null : /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'UNCLASSIFIED'
}

/**
 * Preserve response metadata while body readers consume the observed stream.
 * @param response - response with the demand-driven body.
 * @param source - original response carrying fetch metadata.
 * @returns a response whose methods retain their internal-slot receiver.
 */
function responseMetadata(response: Response, source: Response): Response {
  return new Proxy(response, {
    get(target, property) {
      if (property === 'url' || property === 'redirected' || property === 'type') return source[property]
      if (property === 'clone') return () => responseMetadata(target.clone(), source)
      const value: unknown = Reflect.get(target, property, target)
      const bound: unknown = typeof value === 'function' ? value.bind(target) : value
      return bound
    },
  })
}

/** One request's metadata, body files, timer, signal listener and aggregate counters. */
export class RequestTracker {
  private readonly requestId = randomUUID()
  private readonly startedAtMs = Date.now()
  private readonly nativeFetch = globalThis.fetch
  private fd: number | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private stopped = false
  private listening = false
  private httpCount = 0
  private headersCount = 0
  private consumedBodyBytes = 0
  private capturedBodyBytes = 0
  private bodyCaptureSkipped = 0
  private readonly bodyFiles = new Map<number, BodyFile>()
  private reservedBodyEndBytes = 0
  private firstBodyByteConsumedAtMs: number | null = null
  private lastBodyByteConsumedAtMs: number | null = null
  private normalizedChunkCount = 0
  private lastNormalizedChunkType: StreamChunk['type'] | null = null
  private modelFinished = false
  private firstNormalizedChunkAtMs: number | null = null
  private lastNormalizedChunkAtMs: number | null = null
  private bytesWritten = 0
  private truncated = false
  private signalAborted = false
  private readonly onAbort = () => { this.recordAbort() }

  private recordAbort(): boolean {
    this.signalAborted = true
    return this.record('signal-abort')
  }

  /** Model-call methods; capture failures preserve consumption and model results. */
  readonly observer: LlmRequestDiagnostics = {
    fetch: (input, init) => this.fetch(input, init),
    chunk: (chunk) => { this.chunk(chunk) },
    finish: (outcome, errorCode) => { this.finish(outcome, errorCode) },
  }

  /**
   * Allocate in-memory state; start() acquires resources under the plugin owner.
   * @param options - attribution and signal; content is never inspected.
   * @param config - destination directory and progress interval.
   * @param release - remove this tracker from its owning plugin's active set.
   */
  constructor(
    private readonly options: GenerateOptions<string>,
    private readonly config: Config,
    private readonly release: (tracker: RequestTracker) => void,
  ) {}

  /** Open a private file and start recording; failures leave an inert observer. */
  start(): void {
    try {
      fs.mkdirSync(this.config.directory, { recursive: true, mode: 0o700 })
      this.fd = fs.openSync(join(this.config.directory, `${this.requestId}.ndjson`), 'ax', 0o600)
    } catch (_error: unknown) {
      this.fail()
      return
    }
    if (!this.record('request-start', {
      startedAtMs: this.startedAtMs,
      sessionId: this.options.sessionId?.slice(0, 128) ?? null,
      provider: this.options.provider.slice(0, 128),
      model: this.options.model.slice(0, 128),
      purpose: this.options.purpose?.slice(0, 128) ?? null,
    })) return
    const signal = this.options.signal
    if (signal !== undefined) {
      signal.addEventListener('abort', this.onAbort, { once: true })
      this.listening = true
      if (signal.aborted && !this.recordAbort()) return
    }
    this.timer = setInterval(() => { this.record('progress') }, this.config.progressIntervalMs)
    this.timer.unref()
  }

  private counters(): Metadata {
    return {
      httpObserved: this.httpCount > 0,
      httpCount: this.httpCount,
      truncated: this.truncated,
      headersCount: this.headersCount,
      consumedBodyBytes: this.consumedBodyBytes,
      capturedBodyBytes: this.capturedBodyBytes,
      bodyCaptureSkipped: this.bodyCaptureSkipped,
      firstBodyByteConsumedAtMs: this.firstBodyByteConsumedAtMs,
      lastBodyByteConsumedAtMs: this.lastBodyByteConsumedAtMs,
      normalizedChunkCount: this.normalizedChunkCount,
      lastNormalizedChunkType: this.lastNormalizedChunkType,
      firstNormalizedChunkAtMs: this.firstNormalizedChunkAtMs,
      lastNormalizedChunkAtMs: this.lastNormalizedChunkAtMs,
      signalAborted: this.signalAborted,
    }
  }

  private encode(event: string, metadata: Metadata, compact = false): Buffer {
    return Buffer.from(`${JSON.stringify({ schemaVersion: 1, event, requestId: this.requestId, timeMs: Date.now(), ...(compact ? {} : this.counters()), ...metadata })}\n`)
  }

  private record(event: string, metadata: Metadata = {}, bodyLifecycle = false): boolean {
    if (this.fd === undefined) return false
    const terminal = event === 'finish' || event === 'model-finish' || event === 'observer-disposed' || event === 'signal-abort'
    if (this.truncated && !terminal && !bodyLifecycle) return true
    try {
      let bytes = this.encode(event, metadata, bodyLifecycle)
      // Body references and ends use admission reservations rather than the progress quota.
      const intermediateLimit = this.config.maxFileBytes - TERMINAL_RESERVE - this.reservedBodyEndBytes
      if (!terminal && !bodyLifecycle && this.bytesWritten + bytes.length > intermediateLimit) {
        this.truncated = true
        bytes = this.encode('log-truncated', {})
      }
      // One append can be short; advance by bytes rather than assuming a full write.
      let offset = 0
      while (offset < bytes.length) {
        const written = fs.writeSync(this.fd, bytes, offset, bytes.length - offset)
        if (written === 0) throw new Error('Diagnostic write made no progress')
        offset += written
        this.bytesWritten += written
      }
      return true
    } catch (_error: unknown) {
      this.fail()
      return false
    }
  }

  private fail(): void {
    console.error('llm-request-diagnostics: observation failed; this request continues without diagnostics. Check the diagnostic directory and available disk space.')
    this.close(false)
  }

  private close(recordEnds = true): void {
    if (this.stopped) return
    this.stopped = true
    for (const body of this.bodyFiles.values()) this.endBody(body, 'unfinished', recordEnds)
    if (this.timer !== undefined) clearInterval(this.timer)
    if (this.listening) this.options.signal?.removeEventListener('abort', this.onAbort)
    const fd = this.fd
    this.fd = undefined
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch (_error: unknown) {
        console.error('llm-request-diagnostics: diagnostic file close failed; inspect host file-descriptor health.')
      }
    }
    this.release(this)
  }

  private chunk(chunk: StreamChunk): void {
    if (this.stopped) return
    const timeMs = Date.now()
    this.normalizedChunkCount += 1
    this.lastNormalizedChunkType = chunk.type
    this.lastNormalizedChunkAtMs = timeMs
    if (this.firstNormalizedChunkAtMs === null) {
      this.firstNormalizedChunkAtMs = timeMs
      this.record('normalized-first')
    }
    if (chunk.type === 'finish' && !this.modelFinished) {
      this.modelFinished = true
      const errorCode = chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted' ? chunk.reason.failure.code : undefined
      this.record('model-finish', { finishKind: chunk.reason.kind, errorCode: diagnosticCode(errorCode) })
    }
  }

  private openBody(httpId: number, contentType: string | null): BodyFile | undefined {
    if (this.stopped || this.config.maxResponseBodyBytes === 0) return undefined
    const file = `${this.requestId}.${httpId}.response.bin`
    const metadata: Metadata = { httpId, file, contentType: contentType?.slice(0, 128) ?? null, error: null }
    const openBytes = this.encode('body-open', metadata, true).length
    if (this.bytesWritten + openBytes + this.reservedBodyEndBytes + BODY_END_RESERVE + TERMINAL_RESERVE > this.config.maxFileBytes) {
      this.bodyCaptureSkipped += 1
      return undefined
    }
    const body: BodyFile = { httpId, file, fd: undefined, consumedBytes: 0, writtenBytes: 0, captureError: null }
    this.reservedBodyEndBytes += BODY_END_RESERVE
    this.bodyFiles.set(httpId, body)
    try {
      body.fd = fs.openSync(join(this.config.directory, file), 'wx', 0o600)
    } catch (_error: unknown) {
      body.file = null
      body.captureError = 'open'
      this.bodyFailure()
    }
    this.record('body-open', { ...metadata, file: body.file, error: body.captureError }, true)
    return body
  }

  private bodyFailure(): void {
    console.error('llm-request-diagnostics: response body capture failed; the saved prefix may be incomplete. The model request continues. Check the diagnostic directory, disk space and file-descriptor health.')
  }

  private closeBody(body: BodyFile): void {
    const fd = body.fd
    body.fd = undefined
    if (fd === undefined) return
    try { fs.closeSync(fd) } catch (_error: unknown) {
      body.captureError = 'close'
      this.bodyFailure()
    }
  }

  private endBody(body: BodyFile | undefined, reason: BodyEnd, record = true): void {
    if (body === undefined || !this.bodyFiles.delete(body.httpId)) return
    this.closeBody(body)
    this.reservedBodyEndBytes -= BODY_END_RESERVE
    if (record) this.record('body-end', {
      httpId: body.httpId, file: body.file, reason,
      consumedBytes: body.consumedBytes, writtenBytes: body.writtenBytes,
      truncated: body.consumedBytes > body.writtenBytes,
      error: body.captureError ?? (reason === 'error' ? 'stream' : null),
      incomplete: reason !== 'eof' || body.captureError !== null,
    }, true)
  }

  private raw(bytes: Uint8Array, httpId: number, body: BodyFile | undefined): void {
    if (this.stopped || bytes.byteLength === 0) return
    const size = bytes.byteLength
    if (body !== undefined) {
      body.consumedBytes += size
      const length = Math.min(size, this.config.maxResponseBodyBytes - this.capturedBodyBytes)
      if (body.fd !== undefined) {
        let offset = 0
        try {
          while (offset < length) {
            const written = fs.writeSync(body.fd, bytes, offset, length - offset)
            if (written === 0) throw new Error('Response body write made no progress')
            offset += written
            body.writtenBytes += written
            this.capturedBodyBytes += written
          }
        } catch (_error: unknown) {
          body.captureError = 'write'
          this.bodyFailure()
          this.closeBody(body)
        }
      }
    }
    const timeMs = Date.now()
    this.consumedBodyBytes += size
    this.lastBodyByteConsumedAtMs = timeMs
    if (this.firstBodyByteConsumedAtMs === null) {
      this.firstBodyByteConsumedAtMs = timeMs
      this.record('body-first-byte', { httpId })
    }
  }

  private async fetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
    if (this.stopped) return this.nativeFetch.call(globalThis, input, init)
    const httpId = ++this.httpCount
    this.record('http-dispatch', { httpId })
    let response: Response
    try {
      response = await this.nativeFetch.call(globalThis, input, init)
    } catch (error: unknown) {
      this.record('http-error', { httpId })
      throw error
    }
    this.headersCount += 1
    if (!this.record('http-headers', { httpId, status: response.status })) return response
    const body = response.body
    if (body === null) {
      this.endBody(this.openBody(httpId, response.headers.get('content-type')), 'eof')
      this.record('body-eof', { httpId })
      return response
    }
    try {
      return this.observeBody(response, body, httpId)
    } catch (_error: unknown) {
      this.fail()
      return response
    }
  }

  private observeBody(response: Response, body: ReadableStream<Uint8Array>, httpId: number): Response {
    const reader = body.getReader()
    const capture = this.openBody(httpId, response.headers.get('content-type'))
    let ended = false
    let released = false
    const release = () => {
      if (released) return
      released = true
      reader.releaseLock()
    }
    const stream = new ReadableStream<Uint8Array>({
      // A zero high-water mark prevents prefetching before the consumer asks.
      pull: async (controller) => {
        let result: ReadableStreamReadResult<Uint8Array>
        try {
          result = await reader.read()
        } catch (error: unknown) {
          if (!ended) {
            ended = true
            this.endBody(capture, 'error')
            this.record('body-error', { httpId })
            controller.error(error)
          }
          release()
          return
        }
        if (ended) return
        if (result.done) {
          ended = true
          this.endBody(capture, 'eof')
          this.record('body-eof', { httpId })
          controller.close()
          release()
        } else {
          this.raw(result.value, httpId, capture)
          controller.enqueue(result.value)
        }
      },
      cancel: async (reason) => {
        ended = true
        this.endBody(capture, 'cancel')
        this.record('body-cancel', { httpId })
        try { await reader.cancel(reason) } finally { release() }
      },
    }, { highWaterMark: 0 })
    return responseMetadata(new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }), response)
  }

  private finish(outcome: LlmRequestDiagnosticOutcome, errorCode?: string): void {
    if (this.stopped) return
    for (const body of this.bodyFiles.values()) this.endBody(body, 'unfinished')
    this.record('finish', { outcome, errorCode: diagnosticCode(errorCode) })
    this.close()
  }

  /** Record lifecycle disposal separately from model outcome, then release resources. */
  dispose(): void {
    if (this.stopped) return
    for (const body of this.bodyFiles.values()) this.endBody(body, 'unfinished')
    this.record('observer-disposed')
    this.close()
  }
}
