/** Body bytes are persisted before delivery, with invocation-wide limits and owned cleanup. */

import fs from 'node:fs'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import z from '@deepseek-ai/schemastery'
import { Config, type Config as DiagnosticsConfig } from '../src/index.ts'
import { RequestTracker } from '../src/tracker.ts'

let directory: string
const trackers: RequestTracker[] = []
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'dsh-response-bodies-')) })
afterEach(() => {
  for (const tracker of trackers.splice(0)) tracker.dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  rmSync(directory, { recursive: true, force: true })
})

function resolveConfig(input: Partial<DiagnosticsConfig>): DiagnosticsConfig {
  return z.resolve(input, Config, {})[0] as DiagnosticsConfig
}

function tracker(config: Partial<DiagnosticsConfig> = {}) {
  const subject = new RequestTracker({ provider: 'mock', model: 'mock', messages: [] }, resolveConfig({ directory, ...config }), () => {})
  trackers.push(subject)
  subject.start()
  return subject
}

function records() {
  const filename = readdirSync(directory).find(name => name.endsWith('.ndjson'))!
  return readFileSync(join(directory, filename), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

function bodies() {
  return readdirSync(directory).filter(name => name.endsWith('.response.bin')).sort()
}

function bytes() {
  return bodies().map(file => readFileSync(join(directory, file)))
}

function response(value: Uint8Array) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(value); controller.close() },
  }, { highWaterMark: 0 }))
}

describe('response body files', () => {
  it('defaults to 16 MiB and validates a nonnegative integer budget', () => {
    expect(resolveConfig({ directory }).maxResponseBodyBytes).toBe(16_777_216)
    expect(resolveConfig({ directory, maxResponseBodyBytes: 0 }).maxResponseBodyBytes).toBe(0)
    for (const value of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => resolveConfig({ directory, maxResponseBodyBytes: value })).toThrow()
    }
  })

  it('persists exact raw chunks before delivery and records EOF independently of inference', async () => {
    const ready = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
    const contentType = `text/event-stream; charset=utf-8; boundary=${'a'.repeat(160)}`
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { ready.resolve(controller) },
    }, { highWaterMark: 0 }), { headers: { 'content-type': contentType } })))
    const subject = tracker()
    const received = await subject.observer.fetch('https://fixture.invalid')
    const opened = records().find(row => row.event === 'body-open')!
    expect(opened).toMatchObject({ httpId: 1, contentType: contentType.slice(0, 128), error: null })
    expect(opened.file).toBe(`${opened.requestId}.1.response.bin`)
    expect(bytes()).toEqual([Buffer.alloc(0)])
    const reader = received.body!.getReader()
    const controller = await ready.promise
    const first = new Uint8Array([0, 255, 0xe2])
    controller.enqueue(first)
    expect((await reader.read()).value).toBe(first)
    expect(bytes()).toEqual([Buffer.from(first)])
    expect(records().some(row => row.event === 'body-end')).toBe(false)
    controller.enqueue(new Uint8Array([0x82, 0xac]))
    await reader.read()
    expect(bytes()[0]).toEqual(Buffer.from([0, 255, 0xe2, 0x82, 0xac]))
    controller.close()
    await reader.read()
    expect(records().find(row => row.event === 'body-end')).toMatchObject({
      file: opened.file, reason: 'eof', consumedBytes: 5, writtenBytes: 5, truncated: false, error: null, incomplete: false,
    })
    expect(records().some(row => row.event === 'finish' || row.event === 'model-finish')).toBe(false)
    subject.observer.finish('completed')
  })

  it.skipIf(process.platform === 'win32')('exclusively creates private body files and directories', async () => {
    const open = vi.spyOn(fs, 'openSync')
    vi.stubGlobal('fetch', vi.fn(async () => response(new Uint8Array([1]))))
    const subject = tracker()
    const received = await subject.observer.fetch('https://fixture.invalid')
    await received.arrayBuffer()
    const filename = bodies()[0]!
    expect(open).toHaveBeenCalledWith(join(directory, filename), 'wx', 0o600)
    expect(statSync(join(directory, filename)).mode & 0o777).toBe(0o600)
    subject.dispose()
  })

  it.each([0, 1, 3, 4])('applies a %i-byte budget without altering the response', async (limit) => {
    const value = new Uint8Array([0xe2, 0x82, 0xac, 0xff])
    vi.stubGlobal('fetch', vi.fn(async () => response(value)))
    const subject = tracker({ maxResponseBodyBytes: limit })
    const received = await subject.observer.fetch('https://fixture.invalid')
    expect(new Uint8Array(await received.arrayBuffer())).toEqual(value)
    subject.observer.finish('completed')
    if (limit === 0) {
      expect(bodies()).toEqual([])
      expect(records().some(row => row.event === 'body-open')).toBe(false)
    } else {
      expect(bytes()).toEqual([Buffer.from(value.subarray(0, limit))])
      expect(records().find(row => row.event === 'body-end')).toMatchObject({
        consumedBytes: 4, writtenBytes: limit, truncated: limit < 4, incomplete: false,
      })
    }
    expect(records().at(-1)).toMatchObject({ consumedBodyBytes: 4, capturedBodyBytes: limit })
  })

  it('caps an oversized chunk at the default byte limit', async () => {
    const value = new Uint8Array(16_777_217).fill(0xff)
    vi.stubGlobal('fetch', vi.fn(async () => response(value)))
    const subject = tracker()
    const received = await subject.observer.fetch('https://fixture.invalid')
    expect((await received.arrayBuffer()).byteLength).toBe(value.byteLength)
    expect(statSync(join(directory, bodies()[0]!)).size).toBe(16_777_216)
    expect(records().find(row => row.event === 'body-end')).toMatchObject({ writtenBytes: 16_777_216, truncated: true })
  })

  it('shares the byte budget across interleaved HTTP replies and later retries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(new Uint8Array([1, 2, 3]))))
    const subject = tracker({ maxResponseBodyBytes: 4 })
    const [one, two] = await Promise.all([
      subject.observer.fetch('https://fixture.invalid/one'), subject.observer.fetch('https://fixture.invalid/two'),
    ])
    expect(new Uint8Array(await two.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(new Uint8Array(await one.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    const three = await subject.observer.fetch('https://fixture.invalid/three')
    await three.arrayBuffer()
    expect(bytes()).toEqual([Buffer.from([1]), Buffer.from([1, 2, 3]), Buffer.alloc(0)])
    subject.observer.finish('completed')
    expect(records().at(-1)).toMatchObject({ capturedBodyBytes: 4, consumedBodyBytes: 9, httpCount: 3 })
    expect(records().filter(row => row.event === 'body-end').map(row => [row.httpId, row.writtenBytes, row.truncated])).toEqual([
      [2, 3, false], [1, 1, true], [3, 0, true],
    ])
  })

  it('advances correctly after short body writes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(new Uint8Array([1, 2, 3]))))
    const subject = tracker()
    const received = await subject.observer.fetch('https://fixture.invalid')
    const original = fs.writeSync
    vi.spyOn(fs, 'writeSync').mockImplementationOnce(fd => original(fd, new Uint8Array([1]), 0, 1))
    expect(new Uint8Array(await received.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(bytes()).toEqual([Buffer.from([1, 2, 3])])
    expect(records().find(row => row.event === 'body-end')).toMatchObject({ writtenBytes: 3, error: null })
  })

  it.each(['throw', 'zero'] as const)('retains a short prefix after a %s write failure and preserves consumption', async (failure) => {
    vi.stubGlobal('fetch', vi.fn(async () => response(new Uint8Array([1, 2, 3]))))
    const subject = tracker()
    const received = await subject.observer.fetch('https://fixture.invalid')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const original = fs.writeSync
    vi.spyOn(fs, 'writeSync').mockImplementationOnce(fd => original(fd, new Uint8Array([1]), 0, 1))
      .mockImplementationOnce(() => { if (failure === 'throw') throw new Error('private disk failure'); return 0 })
    expect(new Uint8Array(await received.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(bytes()).toEqual([Buffer.from([1])])
    expect(records().find(row => row.event === 'body-end')).toMatchObject({
      reason: 'eof', consumedBytes: 3, writtenBytes: 1, error: 'write', truncated: true, incomplete: true,
    })
    expect(errors).toHaveBeenCalledOnce()
    expect(errors.mock.calls.flat().join(' ')).not.toContain('private disk failure')
    subject.observer.finish('completed')
    expect(records().at(-1)).toMatchObject({ outcome: 'completed', capturedBodyBytes: 1 })
  })

  it('reports failed body opens without creating a false file reference', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(new Uint8Array([1, 2]))))
    const subject = tracker()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(fs, 'openSync').mockImplementationOnce(() => { throw new Error('private open failure') })
    const received = await subject.observer.fetch('https://fixture.invalid')
    expect(new Uint8Array(await received.arrayBuffer())).toEqual(new Uint8Array([1, 2]))
    expect(bodies()).toEqual([])
    expect(records().find(row => row.event === 'body-open')).toMatchObject({ file: null, error: 'open' })
    expect(records().find(row => row.event === 'body-end')).toMatchObject({ file: null, error: 'open', incomplete: true, writtenBytes: 0 })
    expect(errors).toHaveBeenCalledOnce()
  })

  it('closes active body files when metadata fails and leaves consumer reads usable', async () => {
    const ready = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { ready.resolve(controller) },
    }, { highWaterMark: 0 }))))
    const subject = tracker()
    const received = await subject.observer.fetch('https://fixture.invalid')
    const reader = received.body!.getReader()
    const controller = await ready.promise
    controller.enqueue(new Uint8Array([1]))
    await reader.read()
    const close = vi.spyOn(fs, 'closeSync')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => { throw new Error('private metadata failure') })
    subject.observer.chunk({ type: 'text-delta', index: 0, text: 'content' })
    expect(close).toHaveBeenCalledTimes(2)
    expect(errors).toHaveBeenCalledOnce()
    controller.enqueue(new Uint8Array([2]))
    controller.close()
    expect((await reader.read()).value).toEqual(new Uint8Array([2]))
    expect((await reader.read()).done).toBe(true)
    expect(bytes()).toEqual([Buffer.from([1])])
    expect(records().some(row => row.event === 'body-end' || row.event === 'finish')).toBe(false)
  })

  it('reports body close failure in metadata without replacing model completion', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(new Uint8Array([1, 2]))))
    const subject = tracker()
    const received = await subject.observer.fetch('https://fixture.invalid')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const original = fs.closeSync
    vi.spyOn(fs, 'closeSync').mockImplementationOnce((fd) => { original(fd); throw new Error('private close failure') })
    expect(new Uint8Array(await received.arrayBuffer())).toEqual(new Uint8Array([1, 2]))
    expect(records().find(row => row.event === 'body-end')).toMatchObject({ error: 'close', incomplete: true, writtenBytes: 2 })
    expect(errors).toHaveBeenCalledOnce()
    subject.observer.finish('completed')
    expect(records().at(-1)).toMatchObject({ outcome: 'completed' })
  })

  it.each(['finish', 'dispose'] as const)('marks a pending read unfinished on %s and stops future file writes', async (action) => {
    const entered = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
    const cancelled = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { entered.resolve(controller) }, cancel: cancelled,
    }, { highWaterMark: 0 }))))
    const subject = tracker()
    const received = await subject.observer.fetch('https://fixture.invalid')
    const reader = received.body!.getReader()
    const pending = reader.read()
    const controller = await entered.promise
    if (action === 'finish') subject.observer.finish('completed')
    else subject.dispose()
    expect(records().find(row => row.event === 'body-end')).toMatchObject({ reason: 'unfinished', incomplete: true, writtenBytes: 0 })
    const before = records()
    controller.enqueue(new Uint8Array([1, 2]))
    controller.close()
    expect((await pending).value).toEqual(new Uint8Array([1, 2]))
    expect((await reader.read()).done).toBe(true)
    expect(bytes()).toEqual([Buffer.alloc(0)])
    expect(records()).toEqual(before)
    expect(cancelled).not.toHaveBeenCalled()
  })

  it('preserves cancel rejection and writes one incomplete body end', async () => {
    const failure = new Error('private cancellation failure')
    const cancel = vi.fn(() => { throw failure })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 }))))
    const subject = tracker()
    const received = await subject.observer.fetch('https://fixture.invalid')
    const reason = { private: 'reason' }
    await expect(received.body!.cancel(reason)).rejects.toBe(failure)
    expect(cancel).toHaveBeenCalledWith(reason)
    subject.dispose()
    expect(records().filter(row => row.event === 'body-end')).toEqual([expect.objectContaining({ reason: 'cancel', incomplete: true })])
    expect(JSON.stringify(records())).not.toContain('private')
  })

  it('preserves source errors and the persisted prefix', async () => {
    const ready = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { ready.resolve(controller) },
    }, { highWaterMark: 0 }))))
    const subject = tracker()
    const received = await subject.observer.fetch('https://fixture.invalid')
    const reader = received.body!.getReader()
    const controller = await ready.promise
    controller.enqueue(new Uint8Array([1]))
    await reader.read()
    const failure = new Error('private stream failure')
    controller.error(failure)
    await expect(reader.read()).rejects.toBe(failure)
    expect(bytes()).toEqual([Buffer.from([1])])
    expect(records().find(row => row.event === 'body-end')).toMatchObject({ reason: 'error', error: 'stream', incomplete: true, writtenBytes: 1 })
  })

  it('retains admitted body references and end status after metadata progress truncation', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => response(new Uint8Array([1, 2, 3]))))
    const subject = tracker({ maxFileBytes: 8192, progressIntervalMs: 1 })
    const received = await subject.observer.fetch('https://fixture.invalid')
    await vi.advanceTimersByTimeAsync(100)
    expect(records().some(row => row.event === 'log-truncated')).toBe(true)
    await received.arrayBuffer()
    subject.observer.finish('completed')
    expect(records().filter(row => row.event === 'body-open')).toHaveLength(1)
    expect(records().filter(row => row.event === 'body-end')).toEqual([expect.objectContaining({ reason: 'eof', writtenBytes: 3 })])
    expect(statSync(join(directory, readdirSync(directory).find(name => name.endsWith('.ndjson'))!)).size).toBeLessThanOrEqual(8192)
  })

  it('stops admitting files when metadata cannot reserve their end records', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(new Uint8Array([1]))))
    const subject = tracker({ maxFileBytes: 8192 })
    for (let index = 0; index < 30; index += 1) {
      const received = await subject.observer.fetch('https://fixture.invalid')
      expect(new Uint8Array(await received.arrayBuffer())).toEqual(new Uint8Array([1]))
    }
    subject.observer.finish('completed')
    const count = bodies().length
    expect(count).toBeGreaterThan(0)
    expect(count).toBeLessThan(30)
    expect(records().filter(row => row.event === 'body-open')).toHaveLength(count)
    expect(records().filter(row => row.event === 'body-end')).toHaveLength(count)
    expect(records().at(-1)).toMatchObject({ bodyCaptureSkipped: 30 - count, consumedBodyBytes: 30 })
    expect(statSync(join(directory, readdirSync(directory).find(name => name.endsWith('.ndjson'))!)).size).toBeLessThanOrEqual(8192)
  })
})
