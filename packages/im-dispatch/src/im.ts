/**
 * The identity helpers the dispatch strategy uses, in the plain-string shapes this package's structural types carry
 * (the harness brands its keys; the values are the same strings).
 *
 * They used to be re-exports of `@deepseek-ai/dsh-im`, whose `feat/im-automation` entry exported `ImMessageKey`,
 * `splitKey` and `operationId` as values. The mainline keeps that entry to type exports (`export type * from
 * './api.ts'`) and builds its keys inside `api.ts`, so the three are mirrored here with the same contract —
 * `${bot}|${id}`, split at the first `|` (a bot id never contains one), and the receipt id
 * `sha256(sessionId + '\0' + toolCallId)`.
 *
 * @module dsh-im-dispatch/im
 */

import { createHash } from 'node:crypto'
import { ImError } from '@deepseek-ai/dsh-im'

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
  const at = key.indexOf('|')
  return at < 0 ? { bot: '', id: key } : { bot: key.slice(0, at), id: key.slice(at + 1) }
}

/**
 * The global key of one platform message.
 * @param bot - bot id.
 * @param message - platform message id.
 * @returns `${bot}|${message}`.
 */
export function messageKey(bot: string, message: string): string {
  return `${bot}|${message}`
}

/**
 * The durable receipt key of one tool call of one session.
 * @param sessionId - calling session.
 * @param toolCallId - id of the tool call.
 * @returns the key the host's own tools mint for the same call.
 */
export function operationId(sessionId: string, toolCallId: string): string {
  return createHash('sha256').update(`${sessionId}\u0000${toolCallId}`).digest('hex')
}
