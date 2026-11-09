/** Shipped headless diagnostics retain request progress after a hard process stop. */
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const bin = fileURLToPath(new URL('../../../../src/bin.ts', import.meta.url))
const tsconfig = fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url))

type RecordRow = Record<string, unknown>

async function records(directory: string): Promise<RecordRow[]> {
  let names: string[]
  try { names = await readdir(directory) } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
  const rows: RecordRow[] = []
  for (const name of names.filter(name => name.endsWith('.ndjson'))) {
    const text = await readFile(join(directory, name), 'utf8')
    // Readers may race a short write; an unfinished final line is not a record yet.
    for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n')) {
      if (line) rows.push(JSON.parse(line) as RecordRow)
    }
  }
  return rows
}

// This case asserts POSIX SIGKILL reporting as well as persisted bytes.
it.skipIf(process.platform === 'win32').each([
  { protocol: 'messages', mode: 'headers-pending' },
  { protocol: 'messages', mode: 'body-pending' },
  { protocol: 'responses', mode: 'headers-pending' },
  { protocol: 'responses', mode: 'body-pending' },
  { protocol: 'messages', mode: 'body-capped' },
  { protocol: 'responses', mode: 'body-capped' },
  { protocol: 'messages', mode: 'body-disabled' },
  { protocol: 'responses', mode: 'body-disabled' },
])('persists $protocol $mode diagnostics before headless termination', async ({ protocol, mode }) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-request-diagnostics-')))
  const directory = join(root, 'logs', 'llm-requests')
  const received = Promise.withResolvers<undefined>()
  const maxResponseBodyBytes = mode === 'body-capped' ? 64 : mode === 'body-disabled' ? 0 : 16_777_216
  let sentBody = Buffer.alloc(0)
  const server = createServer((request, response) => {
    request.resume()
    request.once('end', () => {
      received.resolve(undefined)
      if (mode === 'headers-pending') return
      response.writeHead(200, { 'content-type': 'text/event-stream', 'x-private-fixture': 'secret-header-sentinel' })
      response.flushHeaders()
      const events = protocol === 'messages' ? [
        { type: 'message_start', message: { id: 'private-response-id', model: 'diagnostic-fixture', usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'secret-response-body-sentinel' } },
      ] : [
        { type: 'response.created', response: { id: 'private-response-id', status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { id: 'message-fixture', type: 'message', role: 'assistant', content: [] } },
        { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'secret-response-body-sentinel' },
      ]
      sentBody = Buffer.from(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
      response.write(sentBody)
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture did not bind a TCP port')
  const patch = join(root, 'patch.json')
  await writeFile(patch, JSON.stringify([
    ...protocol === 'messages' ? [
      { id: 'llm-deepseek', config: { baseURL: `http://127.0.0.1:${address.port}`, models: [{ id: 'diagnostic-fixture' }], streamIdleTimeoutMs: 60_000 } },
    ] : [
      { id: 'llm-pi-ai', config: { providers: { 'diagnostic-fixture': {
        api: 'openai-responses', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: `http://127.0.0.1:${address.port}/v1`,
        models: [{ id: 'diagnostic-fixture' }], streamIdleTimeoutMs: 60_000,
      } } } },
    ],
    { id: 'agent-default-model', config: { provider: protocol === 'messages' ? 'deepseek-official' : 'diagnostic-fixture', model: 'diagnostic-fixture' } },
    { id: 'session-title-llm', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'llm-request-diagnostics', config: { directory, progressIntervalMs: 25, maxResponseBodyBytes } },
  ]))
  const launch = resolveExampleLaunch({
    srcBin: bin, sourceImport: 'tsx/esm', tsconfigPath: tsconfig,
    configArgs: ['--profile', 'headless', '--patch', patch, '--json', 'secret-request-body-sentinel'],
    env: { DSH_HOME: root, DEEPSEEK_API_KEY: 'secret-key-sentinel', DSH_PERMISSION_MODE: 'workspace-write' },
  })
  const child = execa(launch.command, launch.args, {
    cwd: root, env: { ...process.env, ...launch.env }, reject: false, timeout: 30_000,
  })
  try {
    await Promise.race([
      received.promise,
      child.then((result) => {
        expect(result.timedOut, 'Headless startup exceeded its subprocess deadline').toBe(false)
        throw new Error(`Headless exited before HTTP (exit ${result.exitCode}, signal ${result.signal}): ${result.stderr}\n${result.stdout}`)
      }),
    ])
    await expect.poll(async () => (await records(directory)).some(row => row.event === 'progress'
      && (mode === 'headers-pending' ? row.headersCount === 0 : Number(row.normalizedChunkCount) > 0)), {
      timeout: 15_000,
    }).toBe(true)
    const expectedBody = sentBody.subarray(0, maxResponseBodyBytes)
    const readBodies = async () => {
      const names = (await readdir(directory)).filter(name => name.endsWith('.response.bin'))
      return Promise.all(names.map(name => readFile(join(directory, name))))
    }
    if (mode !== 'headers-pending' && maxResponseBodyBytes > 0) {
      await expect.poll(readBodies, { timeout: 15_000 }).toEqual([expectedBody])
    } else {
      expect(await readBodies()).toEqual([])
    }
    child.kill('SIGKILL')
    const result = await child
    expect(result.timedOut).toBe(false)
    expect(result.signal).toBe('SIGKILL')
    const bodies = await readBodies()
    expect(bodies).toEqual(mode !== 'headers-pending' && maxResponseBodyBytes > 0 ? [expectedBody] : [])
    for (const body of bodies) {
      for (const secret of ['secret-key-sentinel', 'secret-request-body-sentinel', 'secret-header-sentinel']) {
        expect(body.toString('utf8')).not.toContain(secret)
      }
    }
    const persisted = await records(directory)
    const last = persisted.at(-1)!
    expect(persisted[0]?.event).toBe('request-start')
    expect(persisted.some(row => row.event === 'http-dispatch')).toBe(true)
    expect(persisted.some(row => row.event === 'finish')).toBe(false)
    expect(persisted.some(row => row.event === 'body-eof' || row.event === 'model-finish')).toBe(false)
    expect(last.httpObserved).toBe(true)
    if (mode === 'headers-pending') {
      expect(last.headersCount).toBe(0)
      expect(last.consumedBodyBytes).toBe(0)
      expect(last.normalizedChunkCount).toBe(0)
    } else {
      expect(persisted.some(row => row.event === 'http-headers')).toBe(true)
      expect(persisted.some(row => row.event === 'body-first-byte')).toBe(true)
      expect(Number(last.consumedBodyBytes)).toBeGreaterThan(0)
      expect(Number(last.normalizedChunkCount)).toBeGreaterThan(0)
      expect(last.firstBodyByteConsumedAtMs).toEqual(expect.any(Number))
      expect(last.lastNormalizedChunkAtMs).toEqual(expect.any(Number))
    }
    const text = JSON.stringify(persisted)
    for (const secret of ['secret-key-sentinel', 'secret-request-body-sentinel', 'secret-response-body-sentinel', 'secret-header-sentinel', 'private-response-id']) {
      expect(text).not.toContain(secret)
    }
  } finally {
    child.kill('SIGKILL')
    await child
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    await rm(root, { recursive: true, force: true })
  }
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
