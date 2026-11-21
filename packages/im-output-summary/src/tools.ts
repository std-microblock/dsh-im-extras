/**
 * The `no_output` tool: one turn can declare that it publishes nothing.
 *
 * A session whose `spec.output` is this renderer puts every turn into the chat as one message — the progress line, the
 * work being done, and the answer. That is wrong for the turns a person did not ask for in the chat: a click on a card
 * that only updates that card, or background work nobody should read. Such a turn has to be able to say so before it
 * starts publishing, which is what this tool does: it silences the running turn, withdraws what the turn already
 * published, and keeps the closing answer out of the chat too. Everything the turn should say goes out through
 * `im_send` / `im_send_card` instead.
 *
 * The call is the turn's own: the tool resolves the calling agent's hosted session and silences the turn the renderer
 * is publishing for it. A subagent's session publishes nothing of its own, so the call is a no-op there.
 *
 * @module dsh-im-output-summary/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ImApi } from '@deepseek-ai/dsh-im'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ParameterSchemaSpec, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { SummaryRenderer } from './renderer.ts'

/** Name of the tool a silent turn calls first. */
export const NO_OUTPUT_TOOL = 'no_output'

/** Where the guidance sits among the prompt sections, beside the other IM tool guidance. */
export const GUIDANCE_ORDER = 82

/** Name of the guidance section, so a composition can shadow or drop it. */
export const GUIDANCE_SECTION = 'tool:no-output'

/** The guidance text: when a turn must call {@link NO_OUTPUT_TOOL} and when it must not. */
export const GUIDANCE = [
  '# Staying silent (no_output)',
  '',
  'Every turn of this session publishes one message in the chat by itself: the card that opens at its first tool call,',
  'then your answer. `no_output` turns that off for the rest of the turn — but only from the moment it is called.',
  '',
  'The rule is about ordering, not about the work: a turn that should leave the chat untouched makes `no_output` its',
  '**first tool call**. Alone, or in the same batch as the turn\'s other first calls — both are fine, as long as it is',
  'not behind them. The first tool call is what opens the card, so a later `no_output` still withdraws it, but the chat',
  'saw it appear and disappear.',
  '',
  'A turn that answers someone, reports a result or asks a question must not call it: that answer is the message the',
  'person is waiting for. When a silent turn still has to say something, publish it deliberately with `im_send` or',
  '`im_send_card`.',
].join('\n')

/** A refused call, as the tool reports it. */
const errorValue = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', const: 'error', required: true },
    code: { type: 'string', required: true },
    message: { type: 'string', required: true },
  },
} as const satisfies ValueSchemaSpec

/** `no_output` result. */
const output = {
  oneOf: [{
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', const: 'silent', required: true, description: 'This turn publishes nothing.' },
      withdrawn: {
        type: 'boolean',
        required: true,
        description: 'A message this turn had already published was withdrawn from the chat.',
      },
    },
  }, errorValue],
} as const satisfies ValueSchemaSpec

/** Render one result as the text the model reads. */
function render(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * Register `no_output` on a scope that carries the tool registry.
 * @param ctx - scope owning the registration.
 * @param im - IM host, for the hosted session behind the calling agent.
 * @param renderer - the renderer whose running turn the call silences.
 * @returns the disposer that unregisters the tool.
 */
export function applyNoOutputTool(ctx: Context, im: ImApi, renderer: SummaryRenderer): () => void {
  return ctx.tools.register(defineTool({
    name: NO_OUTPUT_TOOL,
    description: 'Publish nothing for the rest of this turn: no card, no answer. The turn\'s first tool call is what '
      + 'opens the card, so a turn that must stay out of the chat makes no_output that first call — alone, or in the '
      + 'same batch as the turn\'s other first calls, but never behind them. Called later it still withdraws the card '
      + 'the turn already showed, but the chat saw it appear and disappear. A turn with an answer to give never calls '
      + 'it: publish that with im_send or im_send_card when the turn is meant to speak instead.',
    parameters: {} satisfies ParameterSchemaSpec,
    output: { schema: output, render },
    execute: async (_args, exec) => {
      const agent = exec.agent
      const record = agent === undefined ? undefined : im.sessions.get(agent.session.id)
      // A subagent (or any session this host does not run) publishes no turn of its own: it is silent already.
      if (record === undefined) return { status: 'silent' as const, withdrawn: false }
      return { status: 'silent' as const, withdrawn: await renderer.silence(record.sessionId) }
    },
  }))
}
