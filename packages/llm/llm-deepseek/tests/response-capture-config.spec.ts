import { describe, expect, it } from 'vitest'
import { Config, resolveAdapterOptions } from '../src/config.ts'

describe('response preview budget', () => {
  it('defaults to 16 MiB and accepts disabled or explicit limits', () => {
    expect(resolveAdapterOptions({}).responseCaptureMaxBytes).toBe(16 * 1024 * 1024)
    expect(Config({}).responseCaptureMaxBytes.get()).toBe(16 * 1024 * 1024)
    for (const responseCaptureMaxBytes of [0, 1, 1024]) {
      expect(Config({ responseCaptureMaxBytes }).responseCaptureMaxBytes.get()).toBe(responseCaptureMaxBytes)
      expect(resolveAdapterOptions({ responseCaptureMaxBytes }).responseCaptureMaxBytes).toBe(responseCaptureMaxBytes)
    }
  })

  it.each([-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])('rejects invalid budget %s at config parsing and resolution', (responseCaptureMaxBytes) => {
    expect(() => Config({ responseCaptureMaxBytes })).toThrow()
    expect(() => resolveAdapterOptions({ responseCaptureMaxBytes })).toThrow('responseCaptureMaxBytes')
  })
})
