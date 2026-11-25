/**
 * The sticker tools: `send_sticker`, `sticker_search`, `sticker_collect`, and the system prompt section that explains
 * them. Each tool resolves the calling agent's hosted IM session; a session may send into and collect from the chats
 * its bindings (or its hosted ancestors' bindings) name.
 *
 * @module dsh-im-stickers/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { ImError, type ImApi, type ImChatKey, type ImSessionRecord } from '@deepseek-ai/dsh-im'
import { operationId } from './keys.ts'
import { defineTool, type ParameterSchemaSpec, type ToolRunContext, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { StickerHost } from './host.ts'
import type { StickerLibrary } from './library.ts'
import { stickerLabel } from './pick.ts'
import { PROMPT_ORDER, PROMPT_SECTION, stickerPrompt } from './prompt.ts'

/** Every sticker tool. */
export const STICKER_TOOLS = ['send_sticker', 'sticker_search', 'sticker_collect'] as const

const errorValue = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', const: 'error', required: true },
    code: { type: 'string', required: true },
    message: { type: 'string', required: true },
  },
} as const satisfies ValueSchemaSpec

const stickerValue = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer', required: true },
    tags: { type: 'array', items: { type: 'string' }, required: true },
    desc: { type: 'string', required: true },
    weight: { type: 'integer', required: true },
    uses: { type: 'integer', required: true },
  },
} as const satisfies ValueSchemaSpec

const sendOutput = {
  oneOf: [{
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', required: true, description: 'confirmed, failed, uncertain or partial, as im_send reports it.' },
      sticker: { type: 'string', required: true, description: 'The sticker that went out: #id and its description.' },
      seq: { type: 'integer' },
      error: { type: 'string' },
    },
  }, errorValue],
} as const satisfies ValueSchemaSpec

const searchOutput = {
  oneOf: [{
    type: 'object',
    additionalProperties: false,
    properties: {
      stickers: { type: 'array', items: stickerValue, required: true },
      total: { type: 'integer', required: true, description: 'Enabled stickers in the library.' },
    },
  }, errorValue],
} as const satisfies ValueSchemaSpec

const collectOutput = {
  oneOf: [{
    type: 'object',
    additionalProperties: false,
    properties: {
      sticker: stickerValue,
      created: { type: 'boolean', required: true, description: 'false when the same picture was already in the library.' },
    },
  }, errorValue],
} as const satisfies ValueSchemaSpec

/**
 * Register the enabled sticker tools.
 * @param ctx - a scope with the `tools` service.
 * @param im - the IM host.
 * @param library - the sticker library.
 * @param host - the sticker host.
 * @param enabled - the tool names the operator enabled.
 */
export function applyTools(ctx: Context, im: ImApi, library: StickerLibrary, host: StickerHost, enabled: readonly string[]): void {
  const render = (_args: unknown, value: unknown): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value) }]

  if (enabled.includes('send_sticker')) {
    ctx.tools.register(defineTool({
      name: 'send_sticker',
      description: 'Send one sticker (an image from the sticker library) into a chat. Name an id from sticker_search, '
        + 'or let the library pick one by tags and a short hint about the mood.',
      parameters: {
        id: { type: 'integer', description: 'Sticker id from sticker_search; omit to let the library pick.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Type ids the sticker must carry, e.g. ["speechless"].' },
        hint: { type: 'string', description: 'A few words about the situation or mood, matched against the stickers.' },
        chat: { type: 'string', description: 'Chat key; defaults to the chat of the message you are answering.' },
      } satisfies ParameterSchemaSpec,
      output: { schema: sendOutput, render },
      execute: (args, exec) => run(async () => {
        const record = caller(im, exec)
        const chat = targetChat(im, record, args.chat)
        let row = args.id === undefined ? undefined : library.get(args.id)
        if (args.id !== undefined && (row === undefined || !row.enabled)) {
          throw new ImError('access', `Sticker #${args.id} does not exist or is disabled.`)
        }
        if (row === undefined) {
          const last = host.lastSentIn(chat)
          row = library.pick({
            ...args.tags?.length ? { tags: args.tags } : {},
            ...args.hint === undefined ? {} : { hint: args.hint },
            ...last === undefined ? {} : { exclude: [last] },
          })
        }
        if (row === undefined) throw new ImError('unavailable', 'No enabled sticker matches; try other tags or none.')
        const result = await host.send(chat, row, { session: record.sessionId, operationId: operationId(record.sessionId, exec.callId) })
        return {
          status: result.status,
          sticker: stickerLabel(row),
          ...result.message === undefined ? {} : { seq: result.message.seq },
          ...result.error === undefined ? {} : { error: result.error },
        }
      }),
    }))
  }

  if (enabled.includes('sticker_search')) {
    ctx.tools.register(defineTool({
      name: 'sticker_search',
      description: 'List enabled stickers of the library with their id, type tags and a one-line description of the '
        + 'picture, heaviest first.',
      parameters: {
        tags: { type: 'array', items: { type: 'string' }, description: 'Type ids every listed sticker must carry.' },
        query: { type: 'string', description: 'Words matched against descriptions and type names.' },
        limit: { type: 'integer', description: 'Most stickers listed (default 20, at most 60).' },
      } satisfies ParameterSchemaSpec,
      output: { schema: searchOutput, render },
      isConcurrencySafe: () => true,
      execute: (args, exec) => run(() => {
        caller(im, exec)
        const rows = library.list({
          enabled: true,
          ...args.tags?.length ? { tags: args.tags } : {},
          ...args.query === undefined ? {} : { query: args.query },
          limit: Math.max(1, Math.min(args.limit ?? 20, 60)),
        })
        return Promise.resolve({ stickers: rows.map(viewOf), total: library.enabledCount() })
      }),
    }))
  }

  if (enabled.includes('sticker_collect')) {
    ctx.tools.register(defineTool({
      name: 'sticker_collect',
      description: 'Save a picture someone posted in a chat into the sticker library, by its media id such as 12.1 '
        + '(from a label like [图片 #12.1]). The library describes and tags it in the background.',
      parameters: {
        id: { type: 'string', required: true, description: 'Media id of the picture: 12.1, #12.1, or 12 for the first picture of message 12.' },
        chat: { type: 'string', description: 'Chat key; defaults to the chat of the message you are answering.' },
        desc: { type: 'string', description: 'Optional one-line description of the picture, if you already know it.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional type ids.' },
      } satisfies ParameterSchemaSpec,
      output: { schema: collectOutput, render },
      execute: (args, exec) => run(async () => {
        const record = caller(im, exec)
        const chat = targetChat(im, record, args.chat, false)
        let collected: { row: Awaited<ReturnType<StickerHost['collect']>>['row']; created: boolean }
        try {
          collected = await host.collect(chat, args.id, exec.signal)
        } catch (error) {
          if (error instanceof ImError) throw error
          throw new ImError('unavailable', error instanceof Error ? error.message : String(error))
        }
        let row = collected.row
        if (args.desc !== undefined || args.tags !== undefined) {
          row = await library.update(row.id, {
            ...args.desc === undefined ? {} : { desc: args.desc },
            ...args.tags === undefined ? {} : { tags: args.tags },
          }) ?? row
        }
        return { sticker: viewOf(row), created: collected.created }
      }),
    }))
  }
}

/**
 * Register the sticker section of hosted sessions' system prompts.
 * @param ctx - a scope with the `systemPrompt` service.
 * @param im - the IM host.
 * @param library - the sticker library.
 * @param enabled - the tool names registered.
 */
export function applyPrompt(ctx: Context, im: ImApi, library: StickerLibrary, enabled: readonly string[]): void {
  ctx.systemPrompt.section({
    name: PROMPT_SECTION,
    order: PROMPT_ORDER,
    interpolate: false,
    text: (context) => {
      const agent = (context as { agent?: { session: { id: string } } }).agent
      const record = agent === undefined ? undefined : im.sessions.of(agent.session.id as never)
      return record === undefined ? '' : stickerPrompt(library.types(), library.enabledCount(), enabled)
    },
  })
}

function viewOf(row: { id: number; tags: string[]; desc: string; weight: number; uses: number }) {
  return { id: row.id, tags: row.tags, desc: row.desc || '(no description yet)', weight: row.weight, uses: row.uses }
}

/** The hosted session of the calling agent. */
function caller(im: ImApi, exec: ToolRunContext): ImSessionRecord {
  const agent = exec.agent
  const record = agent === undefined ? undefined : im.sessions.of(agent.session.id)
  if (record === undefined) throw new ImError('ownership', 'Sticker tools require a session the IM host serves.')
  return record
}

/** Chats a session (and its hosted ancestors) is bound to. */
function boundChats(im: ImApi, record: ImSessionRecord, writable: boolean): Set<string> {
  const chats = new Set<string>()
  let current: ImSessionRecord | undefined = record
  const seen = new Set<string>()
  while (current !== undefined && !seen.has(current.sessionId)) {
    seen.add(current.sessionId)
    for (const binding of current.bindings) if (!writable || binding.writable) chats.add(binding.chat)
    current = current.parent === undefined ? undefined : im.sessions.get(current.parent)
  }
  return chats
}

/** The chat a tool call addresses: the named one, else the trigger's, else the home binding's. */
function targetChat(im: ImApi, record: ImSessionRecord, named: string | undefined, writable = true): ImChatKey {
  const allowed = boundChats(im, record, writable)
  const chat = named ?? im.sessions.trigger(record.sessionId)?.chat.key ?? record.bindings.find(binding => binding.home)?.chat
    ?? record.bindings[0]?.chat
  if (chat === undefined) throw new ImError('access', 'This session is bound to no chat.')
  if (!allowed.has(chat)) throw new ImError('access', `This session may not ${writable ? 'publish into' : 'read'} chat ${chat}.`)
  return chat as ImChatKey
}

/** Run one tool operation, reporting a declared `ImError` as a value. */
async function run<T extends object>(operation: () => Promise<T>): Promise<T | { status: 'error'; code: string; message: string }> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof ImError) return { status: 'error', code: error.code, message: error.message }
    throw error
  }
}
