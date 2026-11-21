/**
 * Model-written progress summaries of running IM turns.
 *
 * The summarizer records the latest agent-loop request of every watched session at the `llm/stream` waterfall. A
 * summary is due once both thresholds have passed since the watch started or since the previous summary started:
 * `progressIntervalMs` milliseconds and `progressMinSteps` further model requests. It then forks that request — the
 * same route, tools, and messages, followed by one appended user input asking for the current progress — and hands
 * the reply's text to the watcher. The fork shares the conversation's prefix, so it reuses the provider's prompt
 * cache, and it never enters the session's model history.
 *
 * Each dispatch is logged first as one log-only
 * `plugin:dsh-im-output-summary/progress-summary-request` record, which together with the log prefix before its
 * `contextSeq` reconstructs the exact model input. One session has at most one summary request in flight; closing its
 * watch aborts it.
 *
 * Both records are plugin records: their types are declared outside the harness's event vocabulary, so each carries
 * the envelope's `ignorable` marker and a reader that does not know them retains and skips them instead of refusing
 * the whole log. Nothing reads them back — they exist to explain a chat that showed no summary.
 */
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type { SummaryConfig } from './config.ts'
import { normalizeSummary, progressPrompt } from './prompt.ts'

/** Exact auxiliary input recorded before one progress-summary dispatch. */
export interface ImProgressSummaryRequestEventData {
  /** Turn whose running request was forked. */
  readonly turn: number
  /** Log offset at the forked request's dispatch: its messages derive from the events before this offset. */
  readonly contextSeq: SessionLogOffset
  /** Exact resolved call configuration of the summary request. */
  readonly config: LlmCallConfig
  /** Exact user text appended after the forked messages. */
  readonly prompt: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Log-only pre-dispatch record of one IM progress-summary model request. */
    'plugin:dsh-im-output-summary/progress-summary-request': ImProgressSummaryRequestEventData
    /** Log-only outcome of one IM progress-summary dispatch, so a chat with no summary can be explained. */
    'plugin:dsh-im-output-summary/progress-summary': ImProgressSummaryEventData
  }
}

/** Outcome of one progress-summary dispatch. */
export interface ImProgressSummaryEventData {
  /** Turn the summary described. */
  readonly turn: number
  /** Lines the chat received; `''` when it received none. */
  readonly summary: string
  /** Why no summary was published: the request failure, or that the turn ended first. Absent when one was published. */
  readonly failure?: string
}

/** Timeout reason code of a summary request that exceeded `progressTimeoutMs`. */
export const PROGRESS_SUMMARY_TIMEOUT_CODE = 'IM_PROGRESS_SUMMARY_TIMEOUT'

/** Receives each new summary of one watched turn, already normalized and bounded. */
export type ProgressListener = (summary: string) => void

/** A feed of model-written progress summaries for running turns. */
export interface ProgressSource {
  /**
   * Summarize one running turn on the configured cadence until the returned function is called.
   * @param sessionId - the hosted session whose turn runs.
   * @param turn - the running turn, recorded with every request.
   * @param listener - receives every non-empty summary while the watch is open.
   * @returns a function that ends the watch, clears its timer, and aborts its in-flight request.
   */
  watch(sessionId: SessionId, turn: number, listener: ProgressListener): () => void
}

/** The latest agent-loop request of one watched session. */
interface Snapshot {
  request: GenerateOptions
  contextSeq: SessionLogOffset
  /** Number of agent-loop requests the watch had observed, this one included. */
  step: number
}

/** One watched turn. */
interface Watch {
  readonly sessionId: SessionId
  readonly turn: number
  readonly listener: ProgressListener
  /** Agent-loop requests observed since the watch started. */
  steps: number
  /** `steps` of the snapshot the previous summary forked; 0 before the first summary. */
  covered: number
  /** The interval elapsed since the last start; cleared when a summary starts. */
  due: boolean
  timer: ReturnType<typeof setTimeout> | undefined
  snapshot: Snapshot | undefined
  inFlight: AbortController | undefined
  closed: boolean
}

/** Owns the request snapshots, the cadence, and the summary requests of every watched turn. */
export class ProgressSummarizer implements ProgressSource {
  private readonly watches = new Map<SessionId, Watch>()

  constructor(readonly ctx: Context, readonly config: SummaryConfig) {}

  /** Subscribe the agent-loop requests and end every watch when `ctx` is disposed. */
  start(): void {
    this.ctx.on('llm/stream', (options, next) => {
      this.observe(options)
      return next()
    }, { global: true, prepend: true })
    this.ctx.effect(() => () => {
      for (const watch of [...this.watches.values()]) this.close(watch)
    })
  }

  watch(sessionId: SessionId, turn: number, listener: ProgressListener): () => void {
    const previous = this.watches.get(sessionId)
    if (previous !== undefined) this.close(previous)
    const watch: Watch = {
      sessionId, turn, listener, steps: 0, covered: 0, due: false,
      timer: undefined, snapshot: undefined, inFlight: undefined, closed: false,
    }
    this.watches.set(sessionId, watch)
    this.arm(watch, this.config.progressFirstDelayMs)
    return () => { this.close(watch) }
  }

  // ---------------------------------------------------------------------------------------------------------------

  /** Record one agent-loop request of a watched session. */
  private observe(options: GenerateOptions): void {
    if (!isAgentLoopRequest(options) || options.sessionId === undefined) return
    const watch = this.watches.get(options.sessionId)
    const session = this.ctx.sessions.get(options.sessionId)
    if (watch === undefined || session === undefined) return
    watch.steps++
    watch.snapshot = { request: options, contextSeq: session.seq, step: watch.steps }
    this.pump(watch)
  }

  /**
   * Start the wait before the next summary.
   * @param watch - the watched turn.
   * @param delayMs - the first summary's delay or the interval between later ones.
   */
  private arm(watch: Watch, delayMs: number): void {
    if (watch.closed) return
    if (watch.timer !== undefined) clearTimeout(watch.timer)
    watch.timer = setTimeout(() => {
      watch.timer = undefined
      watch.due = true
      this.pump(watch)
    }, delayMs)
    watch.timer.unref()
  }

  /** Start a summary when both thresholds have passed and none is in flight. */
  private pump(watch: Watch): void {
    if (watch.closed || watch.inFlight !== undefined || !watch.due) return
    const snapshot = watch.snapshot
    if (snapshot === undefined || snapshot.step - watch.covered < this.config.progressMinSteps) return
    watch.due = false
    watch.covered = snapshot.step
    this.arm(watch, this.config.progressIntervalMs)
    const controller = new AbortController()
    watch.inFlight = controller
    void this.summarize(watch, snapshot, controller.signal).then(
      (summary) => {
        this.record(watch, summary)
        this.ctx.logger.info('IM progress summary of session %s after %d requests (watch closed=%s): %s',
          watch.sessionId, snapshot.step, watch.closed, summary === '' ? '(empty reply)' : JSON.stringify(summary.slice(0, 120)))
        if (!watch.closed && summary !== '') watch.listener(summary)
      },
      (error: unknown) => {
        const failure = error instanceof Error ? error.message : String(error)
        this.record(watch, '', failure)
        // The turn ended before the fork answered: expected, and separate from a request that failed on its own.
        if (controller.signal.aborted && watch.closed) {
          this.ctx.logger.info('IM progress summary of session %s dropped with its turn: %s', watch.sessionId, failure)
          return
        }
        this.ctx.logger.warn('IM progress summary of session %s failed: %s', watch.sessionId, failure)
      },
    ).finally(() => {
      if (watch.inFlight === controller) watch.inFlight = undefined
      this.pump(watch)
    })
  }

  /**
   * Append the outcome of one dispatch to the session log, so a chat that shows no summary can be explained without
   * the console that produced it.
   * @param watch - the watched turn.
   * @param summary - the summary the chat received, or `''` when it received none.
   * @param failure - why no summary was published; absent when one was.
   */
  private record(watch: Watch, summary: string, failure?: string): void {
    const session = this.ctx.sessions.get(watch.sessionId)
    if (session === undefined) return
    appendPluginRecord(session, 'plugin:dsh-im-output-summary/progress-summary', {
      turn: watch.turn,
      summary,
      ...failure === undefined ? {} : { failure },
    })
  }

  /** Fork the snapshot's request with the progress question, log it, and return the normalized reply. */
  private async summarize(watch: Watch, snapshot: Snapshot, signal: AbortSignal): Promise<string> {
    const session = this.ctx.sessions.get(watch.sessionId)
    if (session === undefined) throw new Error('the session is no longer live')
    using callDeadline = deadline(signal, this.config.progressTimeoutMs, PROGRESS_SUMMARY_TIMEOUT_CODE)
    const { signal: _stepSignal, ...request } = snapshot.request
    const prompt = progressPrompt(this.config.locale)
    // The fork is a text-only question: it takes the turn's own messages unchanged, no tools (a summary must not act),
    // and its own effort and output budget. Those two belong to the prepared call — the runtime refuses to dispatch a
    // call whose configuration differs from the prepared one.
    //
    // The messages are not trimmed. A shorter conversation is not cheaper: it replaces the turn's prefix, so the
    // provider's prefix cache stops matching and every later summary pays for the whole prompt again. It is also
    // unsafe — cutting at a message boundary can start the conversation with a tool result whose tool call the cut
    // dropped, and that request is refused before it is sent (`DeepSeek Messages tool result has no matching call`).
    const prepared = await this.ctx.llm.prepareCall({
      ...callConfigOf(request),
      ...this.config.progressReasoningEffort === undefined ? {} : {
        reasoningEffort: this.config.progressReasoningEffort as NonNullable<GenerateOptions['reasoningEffort']>,
      },
      ...this.config.progressMaxTokens === undefined ? {} : { maxTokens: this.config.progressMaxTokens },
    }, callDeadline.signal)
    callDeadline.signal.throwIfAborted()
    const options: GenerateOptions = {
      ...prepared.config,
      ...request.sessionId === undefined ? {} : { sessionId: request.sessionId },
      messages: [...request.messages, { role: 'user', content: [{ type: 'text', text: prompt }] }],
      signal: callDeadline.signal,
    }
    appendPluginRecord(session, 'plugin:dsh-im-output-summary/progress-summary-request', {
      turn: watch.turn,
      contextSeq: snapshot.contextSeq,
      config: prepared.config,
      prompt,
    })
    const assembler = new BlockAssembler()
    let toolCall = false
    for await (const chunk of prepared.stream(options)) {
      callDeadline.signal.throwIfAborted()
      if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') toolCall = true
      assembler.push(chunk)
    }
    callDeadline.signal.throwIfAborted()
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(finish.failure.message)
    const text = assembler.blocks().flatMap(block => (block.type === 'text' ? [block.text] : [])).join('')
    // A reply cut off at `progressMaxTokens` still reports where the turn stands, so only a reply with no text at all
    // is unusable.
    if (text.trim() === '') {
      throw new Error(toolCall
        ? 'the summary model attempted a tool call'
        : `the summary request ended with ${finish.kind} and no text`)
    }
    return normalizeSummary(text, this.config.progressMaxChars)
  }

  /** End one watch: clear its timer and abort its in-flight request. */
  private close(watch: Watch): void {
    if (watch.closed) return
    watch.closed = true
    if (watch.timer !== undefined) clearTimeout(watch.timer)
    watch.timer = undefined
    watch.inFlight?.abort(new Error('the IM turn ended'))
    if (this.watches.get(watch.sessionId) === watch) this.watches.delete(watch.sessionId)
  }
}

/** The call configuration fields of one agent-loop request. */
function callConfigOf(request: Omit<GenerateOptions, 'signal'>): LlmCallConfig {
  return {
    provider: request.provider,
    model: request.model,
    ...request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort },
    ...request.temperature === undefined ? {} : { temperature: request.temperature },
    ...request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens },
    ...request.stop === undefined ? {} : { stop: [...request.stop] },
  }
}

