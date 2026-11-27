/** Pure formatting and validation helpers for IM user display names. */

const MENTION_PLACEHOLDER = /^@_user_\d+$/

/**
 * Strip a trailing `(${userId})` suffix if already present, returning the pure display name.
 * Idempotent: calling this on an already-clean name returns the trimmed name unchanged.
 */
export function stripIdSuffix(name: string, userId: string): string {
  const trimmed = name.trim()
  if (!trimmed || !userId) return trimmed
  const suffix = `(${userId})`
  if (trimmed.endsWith(suffix)) {
    return trimmed.slice(0, -suffix.length).trim()
  }
  return trimmed
}

/**
 * Whether `name` is a real human/bot display name worth caching for `userId` (not empty, not equal to `userId` itself,
 * and not an unresolved platform mention placeholder such as `@_user_1` or `@_all`).
 */
export function isUsableName(name: string | undefined, userId: string): boolean {
  if (name === undefined) return false
  const clean = stripIdSuffix(name, userId)
  if (!clean) return false
  if (clean === userId) return false
  if (clean === '@_all' || MENTION_PLACEHOLDER.test(clean)) return false
  return true
}

/**
 * Format a display name for model-facing transcripts.
 * - `includeId: true`: `张三(ou_xxx)` (idempotent if `rawName` already ends with `(ou_xxx)`).
 * - `includeId: false`: `张三`.
 * - Falls back to `userId` if `rawName` is empty or equals `userId`.
 */
export function formatUserName(rawName: string, userId: string, includeId: boolean): string {
  const clean = stripIdSuffix(rawName, userId)
  if (!clean || clean === userId) return userId
  return includeId ? `${clean}(${userId})` : clean
}

/** Feishu/Lark OpenAPI error codes indicating missing contact/scope permissions. */
const PERMISSION_CODES = new Set([
  99991672, // Access denied — missing required app scope
  99991668, // Invalid access token / unauthorized scope
  99991663, // App has no permission
  99991664, // Forbidden
  41050,    // No user authority (contact visibility scope)
])

const PERMISSION_TEXT = /\b(99991672|99991668|99991663|99991664|41050|forbidden|permission denied|no permission|no user authority|lack.*scope|unauthorized)\b/i

/**
 * Detect whether a platform lookup error is a permission/scope denial that should trip the per-bot circuit breaker
 * instead of being retried on every message.
 */
export function isPermissionError(error: unknown): boolean {
  if (error === null || error === undefined) return false
  if (typeof error === 'object') {
    const record = error as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown; cause?: unknown }
    if (record.status === 403 || record.statusCode === 403) return true
    if (typeof record.code === 'number' && PERMISSION_CODES.has(record.code)) return true
    if (typeof record.code === 'string' && PERMISSION_CODES.has(Number(record.code))) return true
    if (typeof record.message === 'string' && PERMISSION_TEXT.test(record.message)) return true
    if (record.cause !== undefined && isPermissionError(record.cause)) return true
  }
  return typeof error === 'string' && PERMISSION_TEXT.test(error)
}
