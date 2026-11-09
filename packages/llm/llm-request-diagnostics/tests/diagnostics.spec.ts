/** Request-file and stream transparency checks using state barriers and fake clocks. */

import fs from 'node:fs'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { GenerateOptions, LlmRequestDiagnostics } from '@deepseek-ai/dsh-llm'
import * as diagnostics from '../src/index.ts'
import { RequestTracker } from '../src/tracker.ts'

let directory: string
let context: Context | undefined
const trackers: RequestTracker[] = []

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'dsh-request-diagnostics-')) })
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const tracker of trackers.splice(0)) tracker.dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  rmSync(directory, { recursive: true, force: true })
})

function options(overrides: Partial<GenerateOptions<string>> = {}): GenerateOptions<string> {
  return { provider: 'mock', model: 'model', sessionId: SessionId('diagnostic-session'), messages: [], ...overrides }
}

function tracker(overrides: Partial<GenerateOptions<string>> = {}, config: Partial<diagnostics.Config> = {}) {
  const subject = new RequestTracker(options(overrides), {
    directory, progressIntervalMs: 5000, maxFileBytes: 1_048_576, maxResponseBodyBytes: 16_777_216, ...config,
  }, () => {})
  trackers.push(subject)
  subject.start()
  return subject.observer
}

function records() {
  const path = join(directory, readdirSync(directory).find(name => name.endsWith('.ndjson'))!)
  return readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

function text() {
  return readdirSync(directory).filter(name => name.endsWith('.ndjson')).map(name => readFileSync(join(directory, name), 'utf8')).join('')
}

describe('request diagnostics', () => {
  it('records dispatch before delayed headers and progress before finish without reading ahead', async () => {
    vi.useFakeTimers()
    const headers = Promise.withResolvers<Response>()
    const bodyReady = Promise.withResolvers<undefined>()
    let pulls = 0
    const original = new Uint8Array([0, 128, 255])
    const source = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls += 1
        await bodyReady.promise
        controller.enqueue(original)
        controller.close()
      },
    }, { highWaterMark: 0 })
    const native = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis)
      return headers.promise
    })
    vi.stubGlobal('fetch', native)
    const observer = tracker()
    const pending = observer.fetch('https://fixture.invalid/path')
    expect(records().map(row => row.event)).toEqual(['request-start', 'http-dispatch'])
    await vi.advanceTimersByTimeAsync(5000)
    expect(records().at(-1)).toMatchObject({ event: 'progress', headersCount: 0, httpObserved: true })
    headers.resolve(new Response(source, { status: 201 }))
    const response = await pending
    expect(response.status).toBe(201)
    expect(pulls).toBe(0)
    const reader = response.body!.getReader()
    const reading = reader.read()
    await vi.advanceTimersByTimeAsync(5000)
    expect(pulls).toBe(1)
    expect(records().at(-1)).toMatchObject({ event: 'progress', headersCount: 1, consumedBodyBytes: 0 })
    bodyReady.resolve(undefined)
    const first = await reading
    expect(first.value).toBe(original)
    expect(await reader.read()).toEqual({ done: true, value: undefined })
    observer.chunk({ type: 'text-delta', index: 0, text: 'never recorded' })
    expect(records().at(-1)).toMatchObject({ event: 'normalized-first', normalizedChunkCount: 1, consumedBodyBytes: 3 })
    observer.finish('completed')
    expect(records().at(-1)).toMatchObject({ event: 'finish', outcome: 'completed', schemaVersion: 1 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not record URL, headers, messages, tools, bytes, normalized content or abort reason', async () => {
    const sentinel = 'sensitive-SENTINEL-9384'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sentinel, { headers: { authorization: sentinel } })))
    const controller = new AbortController()
    const observer = tracker({ signal: controller.signal, system: sentinel, purpose: 'title', messages: [{ role: 'user', content: [{ type: 'text', text: sentinel }] }] })
    const response = await observer.fetch(`https://fixture.invalid/${sentinel}?key=${sentinel}`, { headers: { authorization: sentinel }, body: sentinel, method: 'POST' })
    expect(await response.text()).toBe(sentinel)
    observer.chunk({ type: 'text-delta', index: 0, text: sentinel })
    controller.abort(new Error(sentinel))
    expect(records().at(-1)).toMatchObject({ event: 'signal-abort', signalAborted: true })
    observer.finish('aborted', sentinel)
    expect(records().at(-1)).toMatchObject({ errorCode: 'UNCLASSIFIED' })
    expect(records().at(-1)).not.toHaveProperty('purpose')
    expect(text()).not.toContain(sentinel)
    expect(records()[0]).toMatchObject({ sessionId: 'diagnostic-session', provider: 'mock', model: 'model', purpose: 'title' })
  })

  it('preserves body errors and cancel reasons while recording only their phase', async () => {
    const failure = new Error('secret body failure')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ pull(controller) { controller.error(failure) } }, { highWaterMark: 0 }))))
    const observer = tracker()
    const response = await observer.fetch('https://fixture.invalid')
    await expect(response.body!.getReader().read()).rejects.toBe(failure)
    expect(records().at(-1)?.event).toBe('body-error')
    expect(text()).not.toContain(failure.message)
    observer.finish('error', 'TRANSPORT')

    const cancelled = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled }, { highWaterMark: 0 }))))
    const second = tracker()
    const reason = { secret: 'cancel sentinel' }
    const pending = await second.fetch('https://fixture.invalid')
    await pending.body!.cancel(reason)
    expect(cancelled).toHaveBeenCalledWith(reason)
    expect(text()).toContain('body-cancel')
    expect(text()).not.toContain('cancel sentinel')
    second.finish('consumer-stopped')
  })

  it('preserves response metadata, headers, clone and body readers', async () => {
    const source = new Response('original body', { status: 202, statusText: 'Accepted', headers: { 'x-fixture': 'value' } })
    Object.defineProperties(source, {
      url: { value: 'https://fixture.invalid/private-path' },
      redirected: { value: true },
      type: { value: 'cors' },
    })
    vi.stubGlobal('fetch', vi.fn(async () => source))
    const observer = tracker()
    const response = await observer.fetch('https://fixture.invalid')
    expect(response.url).toBe(source.url)
    expect(response.redirected).toBe(true)
    expect(response.type).toBe('cors')
    expect(response.statusText).toBe('Accepted')
    expect(response.headers.get('x-fixture')).toBe('value')
    const clone = response.clone()
    expect(clone.url).toBe(source.url)
    expect(await response.text()).toBe('original body')
    expect(response.bodyUsed).toBe(true)
    expect(await clone.text()).toBe('original body')
    observer.finish('completed')
    expect(text()).not.toContain('private-path')
    expect(records().at(-1)).toMatchObject({ consumedBodyBytes: 13 })
  })

  it('cancels a pending body read without enqueueing after cancellation', async () => {
    const entered = Promise.withResolvers<undefined>()
    const cancelled = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull() { entered.resolve(undefined) },
      cancel: cancelled,
    }, { highWaterMark: 0 }))))
    const observer = tracker()
    const response = await observer.fetch('https://fixture.invalid')
    const reader = response.body!.getReader()
    const pending = reader.read()
    await entered.promise
    await reader.cancel('private cancellation')
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(cancelled).toHaveBeenCalledOnce()
    expect(records().at(-1)?.event).toBe('body-cancel')
    observer.finish('consumer-stopped')
  })

  it('isolates simultaneous requests and writes only the first normalized chunk immediately', () => {
    const one = tracker({ purpose: 'first' })
    const two = tracker({ purpose: 'second' })
    expect(readdirSync(directory)).toHaveLength(2)
    one.chunk({ type: 'text-delta', index: 0, text: 'a' })
    const before = text()
    one.chunk({ type: 'text-delta', index: 0, text: 'b' })
    expect(text()).toBe(before)
    one.finish('completed')
    two.finish('completed')
    const rows = readdirSync(directory).map(name => readFileSync(join(directory, name), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>))
    expect(rows.map(row => row.at(-1)?.normalizedChunkCount).sort()).toEqual([0, 2])
    expect(new Set(rows.map(row => row[0]?.requestId)).size).toBe(2)
  })

  it('returns a null-body response unchanged and records EOF', async () => {
    const source = new Response(null, { status: 204 })
    vi.stubGlobal('fetch', vi.fn(async () => source))
    const observer = tracker()
    expect(await observer.fetch('https://fixture.invalid')).toBe(source)
    expect(records().at(-1)).toMatchObject({ event: 'body-eof', consumedBodyBytes: 0 })
    observer.finish('completed')
  })

  it('keeps fetch results intact when the observer closes before headers arrive', async () => {
    const ready = Promise.withResolvers<Response>()
    vi.stubGlobal('fetch', vi.fn(() => ready.promise))
    const observer = tracker()
    const pending = observer.fetch('https://fixture.invalid')
    observer.finish('consumer-stopped')
    const before = text()
    const source = new Response('still consumable')
    ready.resolve(source)
    expect(await pending).toBe(source)
    expect(await source.text()).toBe('still consumable')
    expect(text()).toBe(before)
  })

  it('disables failed observation without taking ownership of an already-locked body', async () => {
    const source = new Response('owned by another consumer')
    const originalReader = source.body!.getReader()
    vi.stubGlobal('fetch', vi.fn(async () => source))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const observer = tracker()
    expect(await observer.fetch('https://fixture.invalid')).toBe(source)
    expect(errors).toHaveBeenCalledOnce()
    originalReader.releaseLock()
    expect(await source.text()).toBe('owned by another consumer')
  })

  it('counts multiple nonempty reads and lets existing bodies finish after disposal', async () => {
    const ready = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
    const source = new ReadableStream<Uint8Array>({ start(controller) { ready.resolve(controller) } }, { highWaterMark: 0 })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(source)))
    const observer = tracker()
    const response = await observer.fetch('https://fixture.invalid')
    const reader = response.body!.getReader()
    const controller = await ready.promise
    controller.enqueue(new Uint8Array(0))
    expect((await reader.read()).value?.byteLength).toBe(0)
    expect(text()).not.toContain('body-first-byte')
    controller.enqueue(new Uint8Array([1, 2, 3]))
    expect((await reader.read()).value?.byteLength).toBe(3)
    controller.enqueue(new Uint8Array([4, 5]))
    expect((await reader.read()).value?.byteLength).toBe(2)
    observer.finish('consumer-stopped')
    expect(records().at(-1)).toMatchObject({ consumedBodyBytes: 5 })
    const before = text()
    controller.enqueue(new Uint8Array([6]))
    expect((await reader.read()).value?.byteLength).toBe(1)
    controller.close()
    expect((await reader.read()).done).toBe(true)
    expect(text()).toBe(before)
  })

  it('preserves a source error racing with consumer cancellation and releases once', async () => {
    const ready = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
    const reading = Promise.withResolvers<undefined>()
    const source = new ReadableStream<Uint8Array>({
      start(controller) { ready.resolve(controller) },
      pull() { reading.resolve(undefined) },
    }, { highWaterMark: 0 })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(source)))
    const observer = tracker()
    const response = await observer.fetch('https://fixture.invalid')
    const reader = response.body!.getReader()
    const pending = reader.read()
    await reading.promise
    const failure = new Error('private source failure')
    ;(await ready.promise).error(failure)
    const cancelling = reader.cancel('private cancellation')
    await expect(cancelling).rejects.toBe(failure)
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(text()).not.toContain('private')
    observer.finish('consumer-stopped')
  })

  it('forwards fetch rejection identity and records no exception string', async () => {
    const failure = new Error('secret fetch failure')
    vi.stubGlobal('fetch', vi.fn(async () => { throw failure }))
    const observer = tracker()
    await expect(observer.fetch('https://fixture.invalid')).rejects.toBe(failure)
    expect(records().at(-1)?.event).toBe('http-error')
    observer.finish('error', 'TRANSPORT')
    expect(text()).not.toContain(failure.message)
  })

  it('keeps failed observation inert without changing fetch or chunk processing', async () => {
    const response = new Response('body')
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const badPath = join(directory, 'not-a-directory')
    writeFileSync(badPath, 'occupied')
    const observer = tracker({}, { directory: join(badPath, 'child') })
    observer.chunk({ type: 'text-delta', index: 0, text: 'secret' })
    observer.finish('error', 'SECRET-WITH-HYPHEN')
    expect(await observer.fetch('https://fixture.invalid')).toBe(response)
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors.mock.calls.flat().join(' ')).not.toContain(badPath)
  })

  it('closes the file if the first synchronous record fails', () => {
    vi.useFakeTimers()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const close = vi.spyOn(fs, 'closeSync')
    vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => { throw new Error('private write error') })
    const observer = tracker()
    expect(close).toHaveBeenCalledOnce()
    expect(errors).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    observer.finish('completed')
    expect(close).toHaveBeenCalledOnce()
  })

  it('stops immediately if recording an already-aborted signal fails', () => {
    vi.useFakeTimers()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const original = fs.writeSync
    const write = vi.spyOn(fs, 'writeSync').mockImplementationOnce(original)
      .mockImplementationOnce(() => { throw new Error('private abort write error') })
    const signal = AbortSignal.abort('private reason')
    const remove = vi.spyOn(signal, 'removeEventListener')
    tracker({ signal })
    expect(write).toHaveBeenCalledTimes(2)
    expect(errors).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('completes short writes and treats a zero write as a failed observer', () => {
    const original = fs.writeSync
    vi.spyOn(fs, 'writeSync').mockImplementationOnce(fd => original(fd, Buffer.from('{'), 0, 1))
    const request = options()
    delete request.sessionId
    const subject = new RequestTracker(request, {
      directory, progressIntervalMs: 5000, maxFileBytes: 1_048_576, maxResponseBodyBytes: 16_777_216,
    }, () => {})
    trackers.push(subject)
    subject.start()
    const observer = subject.observer
    expect(records()[0]).toMatchObject({ event: 'request-start', sessionId: null, purpose: null })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => 0)
    observer.finish('completed')
    expect(errors).toHaveBeenCalledOnce()
    expect(records()).toHaveLength(1)
  })

  it('reports close failure without replacing completion or exposing its cause', () => {
    const observer = tracker()
    const original = fs.closeSync
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(fs, 'closeSync').mockImplementationOnce((fd) => {
      original(fd)
      throw new Error('private close failure')
    })
    observer.finish('completed')
    expect(records().at(-1)).toMatchObject({ event: 'finish', outcome: 'completed' })
    expect(errors).toHaveBeenCalledOnce()
    expect(errors.mock.calls.flat().join(' ')).not.toContain('private')
  })

  it('contains synchronous write failure and stops timer and signal observation', () => {
    vi.useFakeTimers()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const signal = new AbortController()
    const observer = tracker({ signal: signal.signal })
    vi.spyOn(fs, 'writeSync').mockImplementation(() => { throw new Error('secret filesystem failure') })
    observer.chunk({ type: 'text-delta', index: 0, text: 'content' })
    signal.abort('secret signal')
    observer.finish('error', 'SERVER')
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors.mock.calls.flat().join(' ')).not.toContain('secret')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds files and preserves terminal and abort records after truncation', async () => {
    vi.useFakeTimers()
    const signal = new AbortController()
    const observer = tracker({ signal: signal.signal }, { progressIntervalMs: 1, maxFileBytes: 8192 })
    await vi.advanceTimersByTimeAsync(100)
    expect(records().filter(row => row.event === 'log-truncated')).toHaveLength(1)
    signal.abort('not logged')
    observer.finish('aborted', 'A'.repeat(65))
    expect(records().slice(-2).map(row => row.event)).toEqual(['signal-abort', 'finish'])
    expect(records().at(-1)).toMatchObject({ errorCode: 'UNCLASSIFIED', truncated: true })
    expect(statSync(join(directory, readdirSync(directory)[0]!)).size).toBeLessThanOrEqual(8192)
  })

  it.each([
    { kind: 'control', attribution: String.fromCharCode(0).repeat(512) },
    { kind: 'CJK', attribution: '测'.repeat(512) },
    { kind: 'surrogate-pair', attribution: '😀'.repeat(512) },
  ])('preserves start and terminal records within the byte cap for $kind attribution', async ({ attribution }) => {
    vi.useFakeTimers()
    const abort = new AbortController()
    const observer = tracker({
      provider: attribution, model: attribution, sessionId: SessionId(attribution), purpose: attribution, signal: abort.signal,
    }, { maxFileBytes: 8192, progressIntervalMs: 1 })
    expect(records()[0]).toMatchObject({ event: 'request-start', provider: attribution.slice(0, 128) })
    await vi.advanceTimersByTimeAsync(100)
    observer.chunk({ type: 'finish', reason: { kind: 'error', failure: { message: 'private failure', code: 'A'.repeat(64) } } })
    abort.abort('private reason')
    observer.finish('aborted', 'A'.repeat(64))
    expect(records().slice(-3).map(row => row.event)).toEqual(['model-finish', 'signal-abort', 'finish'])
    expect(statSync(join(directory, readdirSync(directory)[0]!)).size).toBeLessThanOrEqual(8192)
    expect(text()).not.toContain('private')
  })

  it.each(['stop', 'error', 'aborted'] as const)('records model %s before iterator cleanup finishes', (kind) => {
    const observer = tracker()
    observer.chunk({ type: 'finish', reason: kind === 'stop' ? { kind } : { kind, failure: { code: 'TRANSPORT', message: 'private' } } })
    expect(records().at(-1)).toMatchObject({ event: 'model-finish', finishKind: kind, lastNormalizedChunkType: 'finish' })
    expect(records().some(row => row.event === 'finish')).toBe(false)
    observer.chunk({ type: 'finish', reason: { kind: 'stop' } })
    expect(records().filter(row => row.event === 'model-finish')).toHaveLength(1)
    observer.finish(kind === 'stop' ? 'completed' : kind)
    expect(records().at(-1)?.event).toBe('finish')
    expect(text()).not.toContain('private')
  })

  it('records abort immediately and removes its listener on idempotent finish', () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const observer = tracker({ signal: controller.signal })
    controller.abort('private reason')
    expect(records().at(-1)?.event).toBe('signal-abort')
    observer.finish('aborted')
    const snapshot = text()
    observer.finish('error', 'SERVER')
    observer.chunk({ type: 'finish', reason: { kind: 'stop' } })
    expect(text()).toBe(snapshot)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('records an already-aborted signal and unknown HTTP coverage', () => {
    const signal = AbortSignal.abort('private reason')
    const observer = tracker({ signal })
    expect(records().at(-1)).toMatchObject({ event: 'signal-abort', httpObserved: false })
    observer.finish('aborted')
  })

  it('loads through YAML and closes active files and timers when its fiber unloads', async () => {
    vi.useFakeTimers()
    const root = join(directory, 'logs')
    const path = join(directory, 'cordis.yml')
    writeFileSync(path, `- name: cordis:diagnostics\n  config:\n    directory: ${JSON.stringify(root)}\n`)
    context = new Context()
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.builtins.diagnostics = diagnostics
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await context.loader.await()
    const observer = context.waterfall('llm/request-diagnostics', options(), () => undefined)
    expect(observer).toBeDefined()
    const files = readdirSync(root)
    expect(files).toHaveLength(1)
    const file = join(root, files[0]!)
    expect(readFileSync(file, 'utf8')).toContain('request-start')
    await vi.advanceTimersByTimeAsync(5000)
    expect(readFileSync(file, 'utf8')).toContain('progress')
    await context.fiber.dispose()
    const snapshot = readFileSync(file, 'utf8')
    expect(snapshot).toContain('observer-disposed')
    expect(vi.getTimerCount()).toBe(0)
    observer!.finish('completed')
    expect(readFileSync(file, 'utf8')).toBe(snapshot)
    expect('default' in diagnostics).toBe(false)
  })

  it('refuses late observer creation after its owner has disposed', async () => {
    context = new Context()
    const registrations = vi.spyOn(context, 'on')
    diagnostics.apply(context, { directory, progressIntervalMs: 5000, maxFileBytes: 8192, maxResponseBodyBytes: 16_777_216 })
    const callback = registrations.mock.calls.find(call => call[0] === 'llm/request-diagnostics')?.[1]
    if (typeof callback !== 'function') throw new Error('Observer listener was not registered')
    const listener = callback as (request: GenerateOptions<string>, next: () => undefined) => LlmRequestDiagnostics | undefined
    await context.fiber.dispose()
    const next = vi.fn(() => undefined)
    expect(listener(options(), next)).toBeUndefined()
    expect(next).toHaveBeenCalledOnce()
    expect(readdirSync(directory)).toEqual([])
  })

  it('calls next and refuses a duplicate tracker while keeping the existing observer', async () => {
    context = new Context()
    await context.plugin(diagnostics, { directory, progressIntervalMs: 5000, maxFileBytes: 8192, maxResponseBodyBytes: 16_777_216 })
    const existing: LlmRequestDiagnostics = { fetch: globalThis.fetch, chunk() {}, finish() {} }
    const next = vi.fn(() => existing)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(context.waterfall('llm/request-diagnostics', options(), next)).toBe(existing)
    expect(next).toHaveBeenCalledOnce()
    expect(readdirSync(directory)).toEqual([])
    expect(errors).toHaveBeenCalledOnce()
  })
})
