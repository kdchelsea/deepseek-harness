/** Serve captured provider JSON only through a Session-owned event reference. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-session-query'
import { REQUEST_BODY_PATH, RESPONSE_BODY_PATH } from './request.ts'

/**
 * Install the authenticated request-body read route.
 * @param ctx - connection, Session query, and attachment storage.
 */
export function registerRequestBody(ctx: Context): void {
  for (const path of [REQUEST_BODY_PATH, RESPONSE_BODY_PATH]) ctx.connection.fetch.register({
    path, methods: ['GET'], requestBody: 'buffered',
    fetch: async (request) => {
      const query = new URL(request.url).searchParams
      const sessionId = query.get('sessionId')
      const seq = query.get('seq')
      if (!sessionId || seq === null || !/^\d+$/.test(seq) || !Number.isSafeInteger(Number(seq))) {
        return new Response('Invalid request coordinates.', { status: 400 })
      }
      const { target } = await ctx.sessionQuery.readEvent({
        sessionId: sessionId as SessionId, seq: Number(seq) as SessionSeq, before: 0, after: 0,
      }, request.signal)
      if (target.type !== 'trajectory/request' && target.type !== 'trajectory/response') {
        return new Response('Provider body not recorded.', { status: 404 })
      }
      if ((path === REQUEST_BODY_PATH) !== (target.type === 'trajectory/request')) {
        return new Response('Provider body not recorded.', { status: 404 })
      }
      const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
      let body = ''
      for await (const chunk of ctx.attachments.readFileStream(target.data.content[0].attachment, request.signal)) {
        body += decoder.decode(chunk, { stream: true })
      }
      body += decoder.decode()
      if (target.type === 'trajectory/response') {
        const { status, contentType, complete } = target.data
        return Response.json({ body, status, contentType, complete }, { headers: { 'cache-control': 'no-store' } })
      }
      return new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
    },
  })
}
