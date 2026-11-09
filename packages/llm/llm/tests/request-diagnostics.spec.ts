/** Request observations preserve model chunks, failures, and iterator cleanup. */
import { describe, expect, it, vi } from 'vitest'
import { withRequestDiagnostics } from '../src/request-diagnostics.ts'
import type { LlmRequestDiagnostics } from '../src/request-diagnostics.ts'
import type { GenerateOptions, StreamChunk } from '../src/types.ts'

const options: GenerateOptions = { provider: 'fixture', model: 'fixture', messages: [] }

function observer() {
  return { fetch, chunk: vi.fn(), finish: vi.fn() } satisfies LlmRequestDiagnostics
}

async function* chunks(...values: StreamChunk[]): AsyncGenerator<StreamChunk> {
  yield* values
}

describe('request diagnostics stream observation', () => {
  it('passes original chunks and settles only after adapter cleanup', async () => {
    const diagnostics = observer()
    const finished = vi.fn()
    const values: StreamChunk[] = [{ type: 'finish', reason: { kind: 'stop' } }]
    async function* source(): AsyncGenerator<StreamChunk> {
      try { yield* values } finally { finished() }
    }
    const output = []
    for await (const chunk of withRequestDiagnostics(options, diagnostics, source())) output.push(chunk)
    expect(output[0]).toBe(values[0])
    expect(diagnostics.chunk).toHaveBeenCalledWith(values[0])
    expect(diagnostics.finish).toHaveBeenCalledExactlyOnceWith('completed', undefined)
    expect(finished).toHaveBeenCalledOnce()
    expect(finished.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(diagnostics.finish).mock.invocationCallOrder[0]!)
  })

  it.each(['error', 'aborted'] as const)('retains a provider %s finish without throwing', async (kind) => {
    const diagnostics = observer()
    const finish: StreamChunk = { type: 'finish', reason: { kind, failure: { code: 'TRANSPORT', message: 'private response' } } }
    const output = []
    for await (const chunk of withRequestDiagnostics(options, diagnostics, chunks(finish))) output.push(chunk)
    expect(output).toEqual([finish])
    expect(diagnostics.finish).toHaveBeenCalledExactlyOnceWith(kind, 'TRANSPORT')
  })

  it('preserves thrown failures and reports only their machine code', async () => {
    const diagnostics = observer()
    const failure = Object.assign(new Error('private credential must not be logged'), { code: 'TRANSPORT' })
    async function* source(): AsyncGenerator<StreamChunk> {
      throw failure
    }
    await expect(withRequestDiagnostics(options, diagnostics, source()).next()).rejects.toBe(failure)
    expect(diagnostics.finish).toHaveBeenCalledExactlyOnceWith('error', 'TRANSPORT')
  })

  it('closes the adapter when the consumer stops before a finish', async () => {
    const diagnostics = observer()
    const closed = vi.fn()
    async function* source(): AsyncGenerator<StreamChunk> {
      try {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally { closed() }
    }
    const iterator = withRequestDiagnostics(options, diagnostics, source())
    await iterator.next()
    await iterator.return(undefined)
    expect(closed).toHaveBeenCalledOnce()
    expect(diagnostics.finish).toHaveBeenCalledExactlyOnceWith('consumer-stopped', undefined)
  })

  it('distinguishes caller cancellation from a provider failure', async () => {
    const diagnostics = observer()
    const controller = new AbortController()
    const failure = new Error('private cancellation reason')
    async function* source(): AsyncGenerator<StreamChunk> {
      controller.abort(failure)
      throw failure
    }
    await expect(withRequestDiagnostics({ ...options, signal: controller.signal }, diagnostics, source()).next()).rejects.toBe(failure)
    expect(diagnostics.finish).toHaveBeenCalledExactlyOnceWith('aborted', undefined)
  })

  it('keeps empty and unobserved streams usable', async () => {
    const diagnostics = observer()
    await expect(withRequestDiagnostics(options, diagnostics, chunks()).next()).resolves.toMatchObject({ done: true })
    expect(diagnostics.finish).toHaveBeenCalledExactlyOnceWith('completed', undefined)
    const value: StreamChunk = { type: 'finish', reason: { kind: 'max-tokens' } }
    await expect(withRequestDiagnostics(options, undefined, chunks(value)).next()).resolves.toEqual({ value, done: false })
  })
})
