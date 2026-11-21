/**
 * The runtime helpers of `@deepseek-ai/dsh-im` the dispatch strategy uses, re-exported with the plain-string keys this
 * package's structural types carry (the harness brands its keys; the values are the same strings).
 *
 * @module dsh-im-dispatch/im
 */

import {
  ImError, ImMessageKey, operationId as imOperationId, splitKey as imSplitKey, type ImChatKey,
} from '@deepseek-ai/dsh-im'

export { ImError }

/**
 * Whether a thrown value is an `ImError`, recognized by name and code so an error of another copy of the class (the
 * task service may load its own) still counts.
 * @param error - the thrown value.
 * @returns whether it carries an IM error code.
 */
export function isImError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && error.name === 'ImError' && typeof (error as { code?: unknown }).code === 'string'
}

/**
 * Split a chat or message key into its bot id and platform id.
 * @param key - `${bot}|${id}`, or a bare id.
 * @returns the bot id (`''` for an unkeyed text) and the platform id.
 */
export function splitKey(key: string): { bot: string; id: string } {
  return imSplitKey(key as ImChatKey)
}

/**
 * The global key of one platform message.
 * @param bot - bot id.
 * @param message - platform message id.
 * @returns `${bot}|${message}`.
 */
export function messageKey(bot: string, message: string): string {
  return ImMessageKey(bot, message)
}

/**
 * The durable receipt key of one tool call of one session.
 * @param sessionId - calling session.
 * @param toolCallId - id of the tool call.
 * @returns the key the host's own tools mint for the same call.
 */
export function operationId(sessionId: string, toolCallId: string): string {
  return imOperationId(sessionId as Parameters<typeof imOperationId>[0], toolCallId)
}
