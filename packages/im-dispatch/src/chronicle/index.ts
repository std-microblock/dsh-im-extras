/**
 * Cross-chat prefix-cached Chronicle module.
 *
 * @module dsh-im-dispatch/chronicle
 */

export * from './api.ts'
export { chronicleDomain, chronicleStore, entryKey } from './domain.ts'
export type { ChronicleGlobal, ChronicleStore } from './domain.ts'
export { CHRONICLE_QUERY_SYSTEM_PROMPT, COMPACT_SYSTEM_PROMPT, parseCompactedOutput } from './prompt.ts'
export { ChronicleService, type ChronicleServiceOptions } from './service.ts'
export { QUERY_CHRONICLE_TOOL, chronicleResultValue } from './tool.ts'
