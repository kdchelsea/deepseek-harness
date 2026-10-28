/** Durable provider request references and their authenticated read route. */
import type { LlmResponseBody } from '@deepseek-ai/dsh-llm/types'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** Authenticated GET route for a provider request recorded in a Session. */
export const REQUEST_BODY_PATH = '/api/trajectory.request-body'


/** Authenticated GET route for raw provider responses stored in a Session. */
export const RESPONSE_BODY_PATH = '/api/trajectory.response-body'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Raw response attachment and HTTP metadata, excluded from model history. */
    'trajectory/response': Omit<LlmResponseBody, 'body'> & { turn: number; step: number; content: [{ type: 'file'; attachment: FileAttachmentRef }] }
    /** Provider JSON stored as a file; the reference never enters the model surface. */
    'trajectory/request': { turn: number; step: number; content: [{ type: 'file'; attachment: FileAttachmentRef }] }
  }
}
