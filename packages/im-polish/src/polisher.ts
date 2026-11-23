/**
 * The decision for one draft: rewrite it, send it as written, or hold it back as a repeat.
 *
 * Two layers keep the bot from saying the same thing twice:
 *
 * 1. **Prompt.** The rewrite sees the recent chat and the bot's own last messages, is told not to sound like them, and
 *    may answer with the skip marker when the draft's substance repeats one of them. The marker is honoured only when
 *    the draft really is close to a recent message (`repeat.modelDropMinSimilarity`), so a confused model cannot
 *    silence new content.
 * 2. **Hard check.** Whatever is about to go out is compared with the bot's recent messages (bigram Dice on the
 *    normalized text). A rewrite at or above `repeat.threshold` gets one more attempt with feedback naming the message
 *    it resembles; when that is still too close, the original goes out if it is not a repeat itself, and otherwise
 *    the send is dropped with a reason the agent can act on.
 *
 * A rewrite that fails the safety check (`checkStyled`: lost link, mention, number or code, extra lines) is never
 * used; the original goes out instead, still subject to the repeat check. A failed or timed-out model call does the
 * same. This module performs no I/O besides the injected completion function.
 *
 * @module dsh-im-polish/polisher
 */
import type { PolishConfig, StyleConfig } from './config.ts'
import type { Complete } from './llm.ts'
import { polishSystem, polishUser } from './prompt.ts'
import { mostSimilar, type SimilarMatch } from './similarity.ts'
import { checkStyled, pickSubStyles, readAnswer } from './style.ts'

/** Everything one decision needs. */
export interface PolishInput {
  /** The text the agent wrote. */
  draft: string
  /** The draft is markdown. */
  markdown: boolean
  /** The recent chat, one line per message. */
  transcript: string
  /** The bot's own recent messages, oldest first. */
  botRecent: readonly string[]
  style: StyleConfig
  /** Per-chat instructions from the rules. */
  note: string
  /** Model route of the rewrite; absent means the draft is only checked for repeats. */
  route?: { provider: string; model: string } | undefined
  signal?: AbortSignal | undefined
}

/** One model attempt, as the polish log shows it. */
export interface PolishAttempt {
  /** The model's answer. */
  raw: string
  /** What became of it: `accepted`, `similar`, `skip`, `skip-ignored`, `rejected <why>`, `error <message>`. */
  verdict: string
}

/** The decision. */
export interface PolishOutcome {
  /** `rewritten`: the rewrite goes out; `kept`: the draft goes out; `dropped`: nothing goes out. */
  action: 'rewritten' | 'kept' | 'dropped'
  /** What goes out (the draft when `kept` or `dropped`). */
  text: string
  /** Why the draft was kept or dropped. */
  reason?: string
  /** For a drop: the sentence the agent reads in its send result. */
  dropMessage?: string
  /** Sub-styles this send drew. */
  subs: string[]
  /** The closest recent message of what was decided on. */
  similar?: SimilarMatch
  attempts: PolishAttempt[]
}

/**
 * Decide what one draft becomes.
 * @param input - the draft and its context.
 * @param config - the operator configuration (`repeat`, `limits`, `model`, `skipMarker`).
 * @param complete - the model call.
 * @param rnd - the die for the sub-style draw.
 * @returns the decision.
 */
export async function decide(
  input: PolishInput, config: PolishConfig, complete: Complete, rnd: () => number = Math.random,
): Promise<PolishOutcome> {
  const { repeat } = config
  const marker = config.skipMarker
  const subs = pickSubStyles(input.style.subs, input.style.pickMin, input.style.pickMax, rnd)
  const attempts: PolishAttempt[] = []
  const draftSimilar = mostSimilar(input.draft, input.botRecent, repeat.minChars)
  const allowSkip = repeat.modelDrop
  let rewrite: string | undefined
  let reason: string | undefined

  if (input.route === undefined) reason = 'no-route'
  else {
    const system = polishSystem({
      style: input.style, subs, markdown: input.markdown, marker, allowSkip, note: input.note,
    })
    let feedback: { attempt: string; similar: string; score: number } | undefined
    const rounds = repeat.retry ? 2 : 1
    for (let round = 0; round < rounds; round++) {
      let raw: string
      try {
        raw = await complete({
          provider: input.route.provider,
          model: input.route.model,
          system,
          user: polishUser({
            transcript: input.transcript, botRecent: input.botRecent, draft: input.draft, marker, allowSkip,
            ...feedback === undefined ? {} : { feedback },
          }),
          temperature: config.model.temperature,
          reasoningEffort: config.model.reasoningEffort,
          timeoutMs: config.model.timeoutMs,
          signal: input.signal,
        })
      } catch (error) {
        if (input.signal?.aborted) throw error
        const message = error instanceof Error ? error.message : String(error)
        attempts.push({ raw: '', verdict: `error ${message}` })
        reason = `error ${message}`
        break
      }
      const answer = readAnswer(raw, marker)
      if (answer.kind === 'skip') {
        if (allowSkip && draftSimilar !== undefined && draftSimilar.score >= repeat.modelDropMinSimilarity) {
          attempts.push({ raw, verdict: 'skip' })
          return {
            action: 'dropped', text: input.draft, reason: 'model-skip', subs, similar: draftSimilar, attempts,
            dropMessage: repeatMessage(draftSimilar, 'model'),
          }
        }
        attempts.push({ raw, verdict: 'skip-ignored' })
        reason = 'skip-ignored'
        break
      }
      const checked = checkStyled(answer.text, input.draft)
      if (checked.text === undefined) {
        attempts.push({ raw, verdict: `rejected ${checked.reason ?? ''}`.trim() })
        reason = `rejected ${checked.reason ?? ''}`.trim()
        break
      }
      const similar = mostSimilar(checked.text, input.botRecent, repeat.minChars)
      if (similar !== undefined && similar.score >= repeat.threshold) {
        attempts.push({ raw, verdict: 'similar' })
        rewrite = checked.text
        feedback = { attempt: checked.text, similar: similar.text, score: similar.score }
        continue
      }
      attempts.push({ raw, verdict: 'accepted' })
      rewrite = checked.text
      reason = undefined
      break
    }
  }

  // The rewrite first, then the draft: the first one that is not a repeat goes out.
  const candidates = rewrite === undefined || rewrite === input.draft ? [input.draft] : [rewrite, input.draft]
  let closest: SimilarMatch | undefined
  for (const text of candidates) {
    const similar = text === input.draft ? draftSimilar : mostSimilar(text, input.botRecent, repeat.minChars)
    if (similar === undefined || similar.score < repeat.threshold) {
      const rewritten = text !== input.draft
      return {
        action: rewritten ? 'rewritten' : 'kept',
        text,
        ...rewritten ? {} : { reason: reason ?? (rewrite !== undefined ? 'rewrite-similar' : 'unchanged') },
        subs, attempts,
        ...similar === undefined ? {} : { similar },
      }
    }
    if (closest === undefined || similar.score > closest.score) closest = similar
  }
  if (!repeat.drop) {
    const text = candidates[0]!
    const rewritten = text !== input.draft
    return {
      action: rewritten ? 'rewritten' : 'kept', text, reason: 'repeat-allowed', subs, attempts,
      ...closest === undefined ? {} : { similar: closest },
    }
  }
  return {
    action: 'dropped', text: input.draft, reason: 'repeat', subs, attempts,
    ...closest === undefined ? {} : { similar: closest, dropMessage: repeatMessage(closest, 'check') },
  }
}

/**
 * The sentence the agent reads when its message was held back: what it resembled, and what to do instead.
 * @param similar - the recent message the draft resembles.
 * @param by - `model` when the rewrite judged it a repeat, `check` when the similarity check did.
 * @returns the reason recorded on the dropped send.
 */
export function repeatMessage(similar: SimilarMatch, by: 'model' | 'check'): string {
  const quoted = similar.text.replace(/\s+/g, ' ').trim()
  const short = quoted.length > 60 ? `${quoted.slice(0, 59)}…` : quoted
  const why = by === 'model' ? '内容重复' : `意思几乎一样（相似度 ${similar.score.toFixed(2)}）`
  return `这条和你刚才说的「${short}」${why}，没有发出。不要原样重发；有新内容就换个说法再说，没有就不用再说了。`
}
