/**
 * The host half of the `qq-panel` tab of `dsh-im-panel`.
 *
 * The panel is optional: the tab is registered through `ctx.inject(['imPanel'], …)` and described structurally, so this
 * package neither imports nor depends on the panel.
 *
 * Routes (all under `/api/im-panel/tab?id=qq-panel`):
 *
 * - `GET path=` (query `bot`): `{ bots, report?, error? }` — the managed bots and the read-only comparison of the
 *   configuration with the platform (menu, panels, pending actions, warnings).
 * - `POST { action: 'sync', resources?: ('menu' | 'panels')[], dryRun?: boolean, bot?: string }`: run a sync.
 * - `POST { action: 'delete', panelId, bot? }`: delete one panel.
 *
 * @module dsh-im-qq-panel/panel
 */

import type { Context } from '@deepseek-ai/cordis'
import { deletePanel, describeError } from './api.ts'
import { formatResult, requestOf, type InspectReport, type QqPanelHost } from './host.ts'

/** The id of the tab. */
export const QQ_PANEL_TAB = 'qq-panel'

/** The part of a panel tab definition this package uses. */
export interface PanelTabDefinition {
  id: string
  title: string
  order?: number
  badge?: () => number | undefined
  read?: (request: { path: string; query: URLSearchParams }) => Promise<unknown>
  command?: (request: { path: string; body: unknown }) => Promise<unknown>
}

/** The part of the panel's host service this package uses. */
export interface PanelHost {
  tab(definition: PanelTabDefinition): () => void
}

/** What the tab's read answers. */
export interface QqPanelTabState {
  bots: { id: string; online: boolean }[]
  bot?: string
  report?: InspectReport
  error?: string
}

/**
 * Register the tab once the panel is mounted.
 * @param ctx - the plugin context.
 * @param host - the plugin's behaviour.
 */
export function applyPanel(ctx: Context, host: QqPanelHost): void {
  ctx.inject(['imPanel' as never], (scoped) => {
    const panel = (scoped as unknown as { imPanel: PanelHost }).imPanel
    scoped.effect(() => panel.tab(qqPanelTab(host)))
  })
}

/**
 * The tab definition.
 * @param host - the plugin's behaviour.
 */
export function qqPanelTab(host: Pick<QqPanelHost, 'bots' | 'inspect' | 'sync' | 'requireBot'>): PanelTabDefinition {
  const pick = (id: string | null | undefined) => {
    const bots = host.bots()
    if (id) {
      const bot = bots.find(candidate => candidate.id === id)
      if (!bot) throw new Error(`没有这个 QQ 机器人：${id}`)
      return bot
    }
    return host.requireBot()
  }
  return {
    id: QQ_PANEL_TAB,
    title: 'QQ 菜单面板',
    order: 70,
    badge: () => {
      const offline = host.bots().filter(bot => bot.status !== 1).length
      return offline > 0 ? offline : undefined
    },
    read: async ({ query }) => {
      const bots = host.bots().map(bot => ({ id: bot.id, online: bot.status === 1 }))
      const state: QqPanelTabState = { bots }
      try {
        const bot = pick(query.get('bot'))
        state.bot = bot.id
        state.report = await host.inspect({ bot })
      } catch (error) {
        state.error = describeError(error)
      }
      return state
    },
    command: async ({ body }) => {
      const command = (body ?? {}) as { action?: string; resources?: ('menu' | 'panels')[]; dryRun?: boolean; bot?: string; panelId?: string }
      const bot = pick(command.bot)
      switch (command.action) {
        case 'sync': {
          const resources = (command.resources ?? ['menu', 'panels']).filter(item => item === 'menu' || item === 'panels')
          const result = await host.sync({ bot, resources, ...command.dryRun === undefined ? {} : { dryRun: command.dryRun } })
          return { ok: result.failures.length === 0, text: formatResult(result) }
        }
        case 'delete': {
          if (!command.panelId) throw new Error('panelId is required')
          await deletePanel(requestOf(bot), command.panelId)
          return { ok: true, text: `已删除面板 ${command.panelId}` }
        }
        default:
          throw new Error(`unknown action ${String(command.action)}`)
      }
    },
  }
}
