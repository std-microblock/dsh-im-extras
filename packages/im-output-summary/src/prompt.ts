/** Model-facing request text and output normalization of the progress summaries. */
import type { SummaryLocale } from './config.ts'

const QUESTION = `This is an independent progress query while the main task continues in parallel. Report the task's current state based on the complete preceding conversation. Do not carry out the task, call tools, or ask questions in this reply. Report only work actually done and plans already decided; do not devise new plans for this report.

Reply with two or three short lines of plain text and nothing else:
- For a large task, three lines: line 1 names the subtask currently underway; line 2 states the operation being performed within it right now; line 3 states the one next step already decided.
- For a small task, two lines: line 1 states the current progress; line 2 states the one next step already decided.

Each line is one sentence with one central action, written for a person following the work in a chat. Say what has been done, not what has been read. Do not recap earlier stages, restate the request, enumerate file paths, identifiers, or code, or invent percentages or problems. Do not add headings, bullets, numbering, quotes, or code fences.`

const LANGUAGE: Record<SummaryLocale, string> = {
  zh: 'Write the lines in Simplified Chinese.',
  en: 'Write the lines in English.',
}

/**
 * The user text appended to the forked conversation.
 * @param locale - reply language of the renderer; the summary is written in it.
 * @returns the complete request text, including its output-language instruction.
 */
export function progressPrompt(locale: SummaryLocale): string {
  return `${QUESTION}\n\n${LANGUAGE[locale]}`
}

/**
 * Normalize one model reply into the lines the chat shows.
 *
 * Code fences, blank lines, and leading list markers are removed; the result is cut at `maxChars` code points with
 * `…` appended when it was longer.
 * @param text - the reply's joined text blocks.
 * @param maxChars - code points kept at most.
 * @returns the summary lines joined by `\n`, or `''` when the reply had no visible text.
 */
export function normalizeSummary(text: string, maxChars: number): string {
  const lines = text
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('```'))
    .map(line => line.replace(/^(?:[-*•]|\d+[.)、])\s*/u, ''))
    .filter(line => line !== '')
  const chars = Array.from(lines.join('\n'))
  return chars.length <= maxChars ? chars.join('') : `${chars.slice(0, maxChars).join('').trimEnd()}…`
}
