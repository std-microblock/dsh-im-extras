/**
 * The identity helpers this package used to import as values from `@deepseek-ai/dsh-im`.
 *
 * The `feat/im-automation` branch exported `ImChatKey`, `ImMessageKey`, `splitKey` and `operationId` from the package
 * entry; the mainline keeps that entry to type exports (`export type * from './api.ts'`) and builds its keys inside
 * `api.ts`. These four are mirrored here with the same contract — `${bot}|${id}`, split at the first `|` (a bot id
 * never contains one), and the receipt id `sha256(sessionId + '\0' + toolCallId)` — so the package does not depend on
 * a value export the mainline no longer offers. The brand types still come from the harness.
 *
 * @module dsh-im-card/keys
 */
import { createHash } from 'node:crypto'
import type { ImChatKey, ImMessageKey } from '@deepseek-ai/dsh-im'

/**
 * The global key of one chat.
 * @param bot - Bot id (`lark:cli_xxx`, `qq:102106848`).
 * @param chat - Platform chat id.
 * @returns the `${bot}|${chat}` key every chat-addressed API takes.
 */
export function chatKey(bot: string, chat: string): ImChatKey {
  return `${bot}|${chat}` as ImChatKey
}

/**
 * The global key of one platform message.
 * @param bot - Bot id.
 * @param message - Platform message id.
 * @returns the `${bot}|${message}` key receipts, quotes and attribution are recorded under.
 */
export function messageKey(bot: string, message: string): ImMessageKey {
  return `${bot}|${message}` as ImMessageKey
}

/**
 * Split a chat or message key into its bot id and platform id.
 * @param key - a key built by {@link chatKey} or {@link messageKey}, or a bare id.
 * @returns the bot id (`''` for an unkeyed text) and the platform id.
 */
export function splitKey(key: string): { bot: string; id: string } {
  const at = key.indexOf('|')
  return at < 0 ? { bot: '', id: key } : { bot: key.slice(0, at), id: key.slice(at + 1) }
}

/**
 * Receipt key tools use: `sha256(sessionId + '\0' + toolCallId)`.
 * @param sessionId - the session whose agent made the tool call.
 * @param toolCallId - the trusted call id of that tool invocation.
 * @returns the operation id that makes a replayed call return the recorded receipt instead of publishing again.
 */
export function operationId(sessionId: string, toolCallId: string): string {
  return createHash('sha256').update(`${sessionId}\u0000${toolCallId}`).digest('hex')
}
