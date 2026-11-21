/**
 * The host half of the polish tab of `dsh-im-panel` (tab id `polish`).
 *
 * The panel is optional: the tab is registered through `ctx.inject(['imPanel'], …)` and described structurally here,
 * so this package neither imports nor depends on the panel.
 *
 * Routes (all under `/api/im-panel/tab?id=polish`):
 *
 * - `GET path=` (or `records`): `{ records, stats, overrides }`; query `chat`, `action`, `q`, `before`, `limit`,
 *   `since` (stats window, epoch ms).
 * - `GET path=chat&chat=<key>`: the effective switch, style and note of one chat.
 * - `POST` `{ action: 'set-chat', chat, enabled: boolean | null }`: the per-chat switch (`null` clears it).
 * - `POST` `{ action: 'clear', chat? }`: delete records.
 * - `POST` `{ action: 'preview', chat, text }`: what the polish would do, nothing sent or recorded.
 *
 * @module dsh-im-polish/panel
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ImChatKey } from '@deepseek-ai/dsh-im'
import type { PolishRecord } from './domain.ts'
import type { ImPolishService } from './index.ts'

/** The id of the polish tab. */
export const POLISH_TAB = 'polish'

/** The part of a panel tab definition this package uses. */
export interface PanelTabDefinition {
  id: string
  title: string
  order?: number
  badge?: () => number | undefined
  read?: (request: { path: string; query: URLSearchParams }) => Promise<unknown>
  command?: (request: { path: string; body: unknown }) => Promise<unknown>
  fetch?: (request: Request, route: { path: string; query: URLSearchParams }) => Promise<Response>
}

/** The part of the panel's host service this package uses. */
export interface PanelHost {
  tab(definition: PanelTabDefinition): () => void
}

/**
 * Register the polish tab once the panel is mounted.
 * @param ctx - the plugin context.
 * @param service - the polish service.
 */
export function applyPanel(ctx: Context, service: ImPolishService): void {
  ctx.inject(['imPanel' as never], (scoped) => {
    const panel = (scoped as unknown as { imPanel: PanelHost }).imPanel
    scoped.effect(() => panel.tab(polishTab(service)))
  })
}

/**
 * The polish tab definition.
 * @param service - the polish service (or anything with the same methods).
 * @returns the definition the panel registers.
 */
export function polishTab(service: Pick<ImPolishService, 'records' | 'stats' | 'overrides' | 'setChat' | 'clear' | 'preview' | 'chatState'>): PanelTabDefinition {
  return {
    id: POLISH_TAB,
    title: '润色',
    order: 50,
    badge: () => {
      const dropped = service.stats({ since: Date.now() - 86400_000 }).dropped
      return dropped > 0 ? dropped : undefined
    },
    read: async ({ path, query }) => {
      if (path === 'chat') {
        const chat = query.get('chat')
        if (!chat) throw new Error('chat is required')
        return service.chatState(chat as ImChatKey)
      }
      if (path !== '' && path !== 'records') throw new Error(`unknown path ${path}`)
      const chat = query.get('chat') ?? undefined
      const action = query.get('action') ?? undefined
      const since = query.get('since')
      return {
        records: service.records({
          ...chat ? { chat } : {},
          ...action === 'rewritten' || action === 'kept' || action === 'dropped' ? { action: action as PolishRecord['action'] } : {},
          ...query.get('q') ? { query: query.get('q')! } : {},
          ...query.get('before') ? { before: query.get('before')! } : {},
          limit: Number(query.get('limit') ?? 50) || 50,
        }),
        stats: service.stats({ ...chat ? { chat } : {}, ...since ? { since: Number(since) } : {} }),
        overrides: service.overrides(),
      }
    },
    command: async ({ body }) => {
      const command = (body ?? {}) as { action?: string; chat?: string; enabled?: boolean | null; text?: string }
      switch (command.action) {
        case 'set-chat': {
          if (!command.chat) throw new Error('chat is required')
          const enabled = command.enabled === null || command.enabled === undefined ? undefined : command.enabled
          await service.setChat(command.chat, enabled)
          return { ok: true, text: enabled === undefined ? '已恢复为配置默认' : enabled ? '已开启润色' : '已关闭润色' }
        }
        case 'clear': {
          const removed = await service.clear(command.chat ? { chat: command.chat } : {})
          return { ok: true, text: `已删除 ${removed} 条记录` }
        }
        case 'preview': {
          if (!command.chat || !command.text) throw new Error('chat and text are required')
          return service.preview(command.chat as ImChatKey, command.text)
        }
        default:
          throw new Error(`unknown action ${String(command.action)}`)
      }
    },
  }
}
