/**
 * Static system prompts and deterministic compactors for the Chronicle (`im_chronicle`).
 *
 * Notice {@link CHRONICLE_QUERY_SYSTEM_PROMPT} is strictly constant: keeping the system prompt, tool absence,
 * sealed chunks, and `sessionId` invariant lets the provider reuse KV prefix caches across queries.
 *
 * @module dsh-im-dispatch/chronicle/prompt
 */

import type { ChronicleEntryKind } from './api.ts'

/** Static system prompt used for one-shot event compaction. */
export const COMPACT_SYSTEM_PROMPT = [
  '你是 IM 机器人全局工作日志（Chronicle）的压缩器。',
  '把下面一条机器人事件压缩为【一句话】，必须明确写出主体对象（哪个人/哪个群/哪个仓库、功能、文档或单号）和具体动作/结论/产出物。',
  '只输出严格 JSON：{"subject":"简短主体(<=24字)","summary":"完整一句话总结(<=120字，不要换行)"}',
  '不要输出 markdown 代码块，不要编造输入中不存在的信息。',
].join('\n')

/**
 * Strictly static system prompt for `query_chronicle` fork queries. Never interpolate dates, counts, or request params.
 */
export const CHRONICLE_QUERY_SYSTEM_PROMPT = [
  '你是 IM 机器人的跨群工作记忆检索助手（Chronicle）。',
  '前置对话消息是由机器人按时间顺序记录的不可变工作日志，每行格式为：',
  '#编号 [YYYY-MM-DD HH:mm] [类型 task:#任务号] [chat=群/私聊key] 主体 — 一句话摘要',
  '现在请仅根据这些已记录日志回答最后一条 <query> 中的问题：',
  '1. 如果找到相关记录，清晰列出核心事实，并附上 `#编号`、`chat` 和 `task #任务号`（如有）。',
  '2. 支持跨群关联：如果不同群聊讨论过同一主题/需求/人/仓库，明确指出各自所在的群与时间线索。',
  '3. 若日志中没有相关信息，直接说明“未找到相关记录”，禁止猜测或编造。',
  '4. 回答简洁客观，直接给结论与证据。',
].join('\n')

/** Build raw event text fed to the compactor. */
export function compactEventInput(input: {
  kind: ChronicleEntryKind
  chat: string
  taskId?: number
  subjectHint: string
  raw: string
}): string {
  const parts = [
    `kind=${input.kind}`,
    `chat=${input.chat}`,
    ...input.taskId === undefined ? [] : [`task=#${input.taskId}`],
    `subject_hint=${input.subjectHint}`,
    'content:',
    input.raw.slice(0, 3000),
  ]
  return parts.join('\n')
}

/** Clean single-line truncation fallback when LLM compaction is absent or returns unparseable text. */
export function sanitizeOneLine(text: string, maxChars: number): string {
  const single = text.replace(/\s+/g, ' ').trim()
  if (single.length <= maxChars) return single
  return `${single.slice(0, Math.max(0, maxChars - 1))}…`
}

/** Parse `{ subject, summary }` from compactor output, tolerating code fences or plain text fallback. */
export function parseCompactedOutput(
  output: string,
  fallbackSubject: string,
  fallbackSummary: string,
): { subject: string; summary: string } {
  const cleaned = output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const jsonStart = cleaned.indexOf('{')
  const jsonEnd = cleaned.lastIndexOf('}')
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1)) as { subject?: unknown; summary?: unknown }
      const subject = typeof parsed.subject === 'string' && parsed.subject.trim()
        ? sanitizeOneLine(parsed.subject, 48)
        : sanitizeOneLine(fallbackSubject, 48)
      const summary = typeof parsed.summary === 'string' && parsed.summary.trim()
        ? sanitizeOneLine(parsed.summary, 220)
        : sanitizeOneLine(fallbackSummary, 220)
      return { subject, summary }
    } catch {
      // Fall through to plain-text normalization.
    }
  }
  const summary = cleaned ? sanitizeOneLine(cleaned, 220) : sanitizeOneLine(fallbackSummary, 220)
  return { subject: sanitizeOneLine(fallbackSubject, 48), summary }
}
