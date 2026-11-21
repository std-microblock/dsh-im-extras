/**
 * The `query_chronicle` tool definition shared by group routers and task workers.
 *
 * @module dsh-im-dispatch/chronicle/tool
 */

import type { ValueSpec } from '../schema.ts'

/** Tool name registered into the IM tool registry when enabled in dispatch config. */
export const QUERY_CHRONICLE_TOOL = 'query_chronicle'

export const chronicleResultValue = {
  type: 'object',
  additionalProperties: false,
  properties: {
    answer: { type: 'string', required: true, description: 'Concise answer synthesized from the Chronicle logs.' },
    entriesScanned: { type: 'integer', required: true, description: 'Number of Chronicle entries scanned.' },
    latestId: { type: 'integer', required: true, description: 'Latest entry #id in the Chronicle.' },
  },
} as const satisfies ValueSpec
