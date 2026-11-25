/**
 * The `im_send_card` tool and the `im-card` skill registration.
 *
 * @module dsh-im-card/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import { ImError, type ImApi, type ImChatKey, type ImMessageKey } from '@deepseek-ai/dsh-im'
import { operationId, splitKey } from './keys.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool, type ParameterSchemaSpec, type ToolRunContext, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-working-directory'
import { bundleCard, CARD_TYPES, CardSourceError, normalizePath, type CardFiles } from './bundle.ts'
import { CardAccessError, type CardService } from './service.ts'
import { CardTreeError } from './tree.ts'

const output = {
  oneOf: [{
    type: 'object',
    additionalProperties: false,
    properties: {
      card: { type: 'string', required: true, description: 'Card id.' },
      status: {
        type: 'string', enum: ['confirmed', 'failed', 'uncertain', 'partial', 'test', 'checked'], required: true,
        description: 'test: published into the test chat; checked: test without a test chat, nothing was sent.',
      },
      message: { type: 'string', description: 'Key of the published message.' },
      error: { type: 'string' },
      notes: {
        type: 'array', items: { type: 'string' },
        description: 'What the chat platform cannot do with this card (no in-place edits, unclickable buttons, no form '
          + 'controls or toasts) and what the card lost when rendered there. Adapt the card when it matters.',
      },
    },
  }, {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', const: 'error', required: true },
      code: { type: 'string', required: true },
      message: { type: 'string', required: true },
    },
  }],
} as const satisfies ValueSchemaSpec

/** A card failure as the declared error value the model reads. */
function cardError(error: unknown): { status: 'error'; code: string; message: string } {
  if (error instanceof ImError) return { status: 'error', code: error.code, message: error.message }
  if (error instanceof CardAccessError) return { status: 'error', code: 'access', message: error.message }
  if (error instanceof CardSourceError || error instanceof CardTreeError) return { status: 'error', code: 'card', message: error.message }
  if (error instanceof Error && /card (module|call|render) failed/.test(error.message)) {
    return { status: 'error', code: 'card', message: error.message }
  }
  throw error
}

/** Where card type definitions are written in the working directory, for the model's own editor or `tsc`. */
export const TYPES_PATH = '.dsh/im-card/dsh-card.d.ts'

/**
 * Register `im_send_card`, `im_update_card`, `im_list_cards` and `im_card_types` on a context with `tools`, `fs` and
 * `workingDirectory`.
 * @param ctx - scope owning the registration.
 * @param im - IM host (sessions, grants).
 * @param cards - card service.
 */
export function applyCardTool(ctx: Context, im: ImApi, cards: CardService): void {
  const render = (_args: unknown, value: unknown): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value) }]

  /** Bundle one entry file of the calling session's working directory, and name that directory. */
  const bundleFor = async (exec: ToolRunContext, path: string) => {
    const { session, agent } = caller(im, exec)
    const cwd = await ctx.workingDirectory.ensure(agent, exec.signal)
    const target = await ctx.fs.resolve(path, { cwd, signal: exec.signal })
    const root = await ctx.fs.resolve('.', { cwd, signal: exec.signal })
    const files: CardFiles = {
      read: async (candidate) => {
        try {
          const file = await ctx.fs.resolve(candidate, { cwd, signal: exec.signal })
          const info = await ctx.fs.stat(file, exec.signal)
          if (info?.type !== 'file') return undefined
          return await ctx.fs.readText(file, exec.signal)
        } catch {
          // An unreadable candidate is the same as an absent one: the bundler tries the next extension.
          return undefined
        }
      },
    }
    const bundle = await bundleCard({ path: normalizePath(ctx.fs.processPath(target)) }, files, {
      maxModules: cards.config.maxModules, maxBytes: cards.config.maxSourceBytes,
    })
    return { session, bundle, cwd: ctx.fs.processPath(root) }
  }

  ctx.tools.register(defineTool({
    name: 'im_send_card',
    description: 'Publish an interactive card into an IM chat you may write. The card is a TypeScript/TSX file '
      + 'that default-exports a component (see the im-card skill); it may import "dsh:card" and other relative files. '
      + 'A card can also keep state in its data folder (fs / useStoredState) and call an API (fetch). '
      + 'Before anything is sent the card is type-checked, rendered and checked against the platform limits; any '
      + 'failure comes back with its reason and nothing reaches the chat. Use test: true while developing a card: it '
      + 'goes to the test chat instead of the conversation (or, without one, is only checked), so failed attempts '
      + 'never clutter the chat. Clicks run its handlers, state changes update the card in place, and the card '
      + 'survives restarts. Platforms differ (Lark edits cards in place and answers clicks with toasts; QQ shows markdown '
      + 'with a keyboard, cannot edit, and has no forms): the result notes say what this chat cannot do. Returns the '
      + 'card id (for im_update_card).',
    parameters: {
      path: { type: 'string', required: true, description: 'Entry .tsx file, relative to your working directory.' },
      props: { type: 'json', description: 'JSON props passed to the default-exported component.' },
      chat: { type: 'string', description: 'Chat key or id; defaults to your home chat.' },
      quote: { type: 'string', description: 'Message key (bot|id) or seq (#12) to reply to.' },
      test: {
        type: 'boolean',
        description: 'Try the card first: publish it into the test chat (not the conversation), or only check it when '
          + 'no test chat is configured. Publish for real once it looks right.',
      },
    } satisfies ParameterSchemaSpec,
    output: { schema: output, render },
    execute: async (args, exec) => {
      try {
        const { session, bundle, cwd } = await bundleFor(exec, args.path)
        const props = args.props ?? {}
        const testChat = cards.config.testChat as ImChatKey | undefined
        if (args.test === true) {
          // A rehearsal is checked against the chat it would really go to; the test chat is an operator setting, so
          // it needs no grant of this session.
          const real = chatOf(im, session, args.chat)
          const { notes } = await cards.rehearse({ bundle, props, chat: testChat ?? real, cwd })
          const noted = notes.length === 0 ? {} : { notes }
          if (testChat === undefined) return { card: '', status: 'checked' as const, ...noted }
          const published = await cards.publish({ bundle, props, session, chat: testChat, grant: false, cwd })
          return {
            card: published.id, status: published.status === 'confirmed' ? 'test' as const : published.status,
            ...published.error === undefined ? {} : { error: published.error },
            ...noted,
          }
        }
        const chat = chatOf(im, session, args.chat)
        const { notes } = await cards.rehearse({ bundle, props, chat, cwd })
        const quote = args.quote === undefined ? undefined : quoteOf(im, chat, args.quote)
        const published = await cards.publish({
          bundle, props, session, chat, cwd,
          ...quote === undefined ? {} : { quote },
          operationId: operationId(session, exec.callId),
        })
        return {
          card: published.id, status: published.status,
          ...published.message === undefined ? {} : { message: published.message },
          ...published.error === undefined ? {} : { error: published.error },
          ...notes.length === 0 ? {} : { notes },
        }
      } catch (error) {
        return cardError(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'im_update_card',
    description: 'Hot-reload a card you published with new code: rebuild it from its entry file (or another one) and '
      + 'replace it in place in the same message. The card restarts from fresh state (useState initial values; props '
      + 'kept unless you pass new ones). If the new code fails to type-check or render, the card keeps running '
      + 'unchanged and the errors come back.',
    parameters: {
      card: { type: 'string', required: true, description: 'Card id from im_send_card or im_list_cards.' },
      path: { type: 'string', description: 'Entry .tsx file; defaults to the entry the card was built from.' },
      props: { type: 'json', description: 'New JSON props; defaults to the current props.' },
    } satisfies ParameterSchemaSpec,
    output: { schema: updateOutput, render },
    execute: async (args, exec) => {
      try {
        const { session } = caller(im, exec)
        const known = cards.cardsOf(session).find(card => card.id === args.card)
        if (known === undefined) throw new CardAccessError(`you published no card ${args.card}`)
        const path = args.path ?? (known.entry.startsWith('inline:') ? undefined : known.entry)
        if (path === undefined) {
          throw new CardAccessError(`card ${args.card} came from a satori-tsx block; pass path to reload it from a file`)
        }
        const { bundle } = await bundleFor(exec, path)
        await cards.reload({ card: args.card, bundle, session, ...args.props === undefined ? {} : { props: args.props } })
        return { card: args.card, status: 'reloaded' as const }
      } catch (error) {
        return cardError(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'im_list_cards',
    description: 'List the cards you published, newest first: id, entry file, message key, and whether closed.',
    parameters: {} satisfies ParameterSchemaSpec,
    output: { schema: listOutput, render },
    isConcurrencySafe: () => true,
    execute: async (_args, exec) => {
      try {
        const { session } = caller(im, exec)
        return { cards: cards.cardsOf(session).slice(0, 30).map(({ updatedAt: _u, ...card }) => card) }
      } catch (error) {
        return cardError(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'im_card_types',
    description: `Write the card type definitions (module "dsh:card" and the JSX elements) to ${TYPES_PATH} in your `
      + 'working directory and return the path, so you can read the exact element and attribute types or run tsc.',
    parameters: {} satisfies ParameterSchemaSpec,
    output: { schema: typesOutput, render },
    isConcurrencySafe: () => true,
    execute: async (_args, exec) => {
      try {
        const { agent } = caller(im, exec)
        const cwd = await ctx.workingDirectory.ensure(agent, exec.signal)
        const target = await ctx.fs.resolve(TYPES_PATH, { cwd, signal: exec.signal })
        await ctx.fs.writeBytes(target, new TextEncoder().encode(CARD_TYPES), undefined, exec.signal)
        return { path: ctx.fs.processPath(target) }
      } catch (error) {
        return cardError(error)
      }
    },
  }))
}

const errorValue = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', const: 'error', required: true },
    code: { type: 'string', required: true },
    message: { type: 'string', required: true },
  },
} as const satisfies ValueSchemaSpec

const updateOutput = {
  oneOf: [{
    type: 'object',
    additionalProperties: false,
    properties: {
      card: { type: 'string', required: true },
      status: { type: 'string', const: 'reloaded', required: true },
    },
  }, errorValue],
} as const satisfies ValueSchemaSpec

const listOutput = {
  oneOf: [{
    type: 'object',
    additionalProperties: false,
    properties: {
      cards: {
        type: 'array', required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            entry: { type: 'string', required: true },
            message: { type: 'string' },
            closed: { type: 'boolean', required: true },
          },
        },
      },
    },
  }, errorValue],
} as const satisfies ValueSchemaSpec

const typesOutput = {
  oneOf: [{
    type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true } },
  }, errorValue],
} as const satisfies ValueSchemaSpec
function caller(im: ImApi, exec: ToolRunContext): { session: SessionId; agent: NonNullable<ToolRunContext['agent']> } {
  const agent = exec.agent
  const record = agent === undefined ? undefined : im.sessions.of(agent.session.id)
  if (agent === undefined || record === undefined) throw new ImError('ownership', 'im_send_card requires an IM session.')
  return { session: record.sessionId, agent }
}

function bindingsOf(im: ImApi, session: SessionId): { chat: ImChatKey; writable: boolean; home?: boolean }[] {
  const out: { chat: ImChatKey; writable: boolean; home?: boolean }[] = []
  let record = im.sessions.of(session)
  for (let depth = 0; record !== undefined && depth < 16; depth++) {
    out.push(...record.bindings)
    record = record.parent === undefined ? undefined : im.sessions.get(record.parent)
  }
  return out
}

function chatOf(im: ImApi, session: SessionId, value: string | undefined): ImChatKey {
  const bindings = bindingsOf(im, session).filter(binding => binding.writable)
  if (value === undefined) {
    const home = bindings.find(binding => binding.home === true) ?? bindings[0]
    if (home === undefined) throw new ImError('access', 'This session may publish into no IM chat.')
    return home.chat
  }
  const trimmed = value.trim()
  const binding = bindings.find(entry => entry.chat === trimmed) ?? bindings.find(entry => splitKey(entry.chat).id === trimmed)
  if (binding === undefined) throw new ImError('access', `Chat ${value} is not writable for this session.`)
  return binding.chat
}

function quoteOf(im: ImApi, chat: ImChatKey, value: string): ImMessageKey {
  const trimmed = value.trim()
  const seq = /^#?(\d+)$/.exec(trimmed)
  if (seq !== null) {
    const n = Number(seq[1])
    const message = im.history.after(chat, n - 1, 1).find(candidate => candidate.seq === n)
    if (message === undefined) throw new ImError('access', `Chat ${chat} holds no message ${value}.`)
    return message.key
  }
  const bot = splitKey(chat).bot
  return (trimmed.includes('|') ? trimmed : `${bot}|${trimmed}`) as ImMessageKey
}
