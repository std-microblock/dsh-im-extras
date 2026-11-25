/**
 * The receipt helper this package used to import as a value from `@deepseek-ai/dsh-im`: the `feat/im-automation`
 * branch exported `operationId` from the package entry, the mainline keeps that entry to type exports. The id is
 * `sha256(sessionId + '\0' + toolCallId)`, exactly what the harness's own tools mint for the same call.
 *
 * @module dsh-im-session-tasks/keys
 */
import { createHash } from 'node:crypto'

/**
 * Receipt key tools use: `sha256(sessionId + '\0' + toolCallId)`.
 * @param sessionId - the session whose agent made the tool call.
 * @param toolCallId - the trusted call id of that tool invocation.
 * @returns the operation id that makes a replayed call return the recorded task instead of starting another.
 */
export function operationId(sessionId: string, toolCallId: string): string {
  return createHash('sha256').update(`${sessionId}\u0000${toolCallId}`).digest('hex')
}
