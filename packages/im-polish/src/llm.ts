/**
 * One auxiliary model call: a system prompt and one user message in, the reply text out.
 *
 * The call goes through `ctx.llm.prepareCall` and the prepared stream like every other auxiliary request in the
 * harness (session titles, progress summaries), so `llm/stream` listeners, retry policy and accounting see it. When
 * the operator configured no reasoning effort, the cheapest one the route offers (`off`, else `low`) is chosen: the
 * polish has to finish while the agent waits for its message to go out.
 *
 * @module dsh-im-polish/llm
 */
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage, type GenerateOptions, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { deadline } from '@deepseek-ai/dsh-timeout'

/** Route and controls of one auxiliary call. */
export interface CompletionRequest {
  provider: string
  model: string
  system: string
  /** User message content: text, or text plus images. */
  user: string | ContentBlock[]
  temperature?: number | undefined
  maxTokens?: number | undefined
  reasoningEffort?: string | undefined
  timeoutMs: number
  signal?: AbortSignal | undefined
}

/** Timeout reason code of an auxiliary call that exceeded its budget. */
export const COMPLETION_TIMEOUT_CODE = 'IM_POLISH_TIMEOUT'

/**
 * Run one auxiliary call to completion.
 * @param ctx - a context carrying `llm`.
 * @param request - route, prompt, controls and deadline.
 * @returns the reply text (empty when the model produced none).
 * @throws Error when the route fails, the deadline passes or the caller aborts.
 */
export async function complete(ctx: Context, request: CompletionRequest): Promise<string> {
  using callDeadline = deadline(request.signal, request.timeoutMs, COMPLETION_TIMEOUT_CODE)
  const prepared = await ctx.llm.prepareCall({
    provider: request.provider,
    model: request.model,
    ...request.temperature === undefined ? {} : { temperature: request.temperature },
    ...request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens },
  }, callDeadline.signal, (controls, model) => {
    const efforts = model.reasoning?.efforts.map(effort => effort.id as string) ?? []
    const wanted = request.reasoningEffort
      ?? (efforts.includes('off') ? 'off' : efforts.includes('low') ? 'low' : undefined)
    return wanted === undefined || (efforts.length > 0 && !efforts.includes(wanted))
      ? controls
      : { ...controls, reasoningEffort: wanted as NonNullable<GenerateOptions['reasoningEffort']> }
  })
  const content: ContentBlock[] = typeof request.user === 'string' ? [{ type: 'text', text: request.user }] : request.user
  const options: GenerateOptions = {
    ...prepared.config,
    system: request.system,
    messages: [createUserMessage({ content, source: { kind: 'user' } })],
    signal: callDeadline.signal,
  }
  const assembler = new BlockAssembler()
  for await (const chunk of prepared.stream(options)) {
    callDeadline.signal.throwIfAborted()
    assembler.push(chunk)
  }
  callDeadline.signal.throwIfAborted()
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(finish.failure.message)
  return assembler.blocks().flatMap(block => (block.type === 'text' ? [block.text] : [])).join('')
}

/** The completion function the polisher calls; a test passes a stub. */
export type Complete = (request: Omit<CompletionRequest, 'provider' | 'model'> & { provider: string; model: string }) => Promise<string>
