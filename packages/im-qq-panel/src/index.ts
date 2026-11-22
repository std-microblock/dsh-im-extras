/**
 * `dsh-im-qq-panel` — the QQ official bot's custom menu (`/v2/menu`, C2C) and command panels (`/v2/panels`) for the
 * DeepSeek Harness IM host, plus the group-owner authorization command `/授权全消息 <群号>`.
 *
 * - **Configured sync**: the menu and panels declared in the plugin row are aligned with the platform when a QQ bot
 *   comes online — read first, write only what differs, stop the run on the platform rate limit (`40023001`), touch
 *   only panels whose remark carries `remarkPrefix`, never send an empty menu unless allowed, and recreate a panel
 *   whose scope or target type changed (the platform cannot change them).
 * - **Generated panels**: a `source: commands` panel lists the bot's commands — the built-ins of
 *   `dsh-im-session-commands` (declared in this configuration), the `/skill` commands of `dsh-im-dispatch`
 *   (`ctx.imDispatch.skills()`) and configured extras.
 * - **Management commands** on `im/message` (admins only): `/qqmenu`, `/qqmenu.sync`, `/qqpanel`, `/qqpanel.sync`,
 *   `/qqpanel.group`, `/qqpanel.delete <id>`, `/qqsync`.
 * - **Authorization**: `/授权全消息 <群号>` (alias `/qqauth`) answers a link button to the owner's authorization sheet.
 *
 * Requests go through the QQ adapter's own authenticated REST client (`bot.api.request`); the plugin holds no
 * credential. Service: `ctx.qqPanel`. With `dsh-im-panel` mounted, a “QQ 菜单面板” tab shows the state and syncs.
 *
 * @module dsh-im-qq-panel
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-im-core'
import type { ImMessageEvent, ImOutcome } from '@deepseek-ai/dsh-im'
import { Config } from './config.ts'
import {
  QqPanelHost, type InspectReport, type MessageEventLike, type OutcomeLike, type QqBotLike, type SlashSkillLike,
  type SyncOptions, type SyncResult,
} from './host.ts'
import { applyPanel } from './panel.ts'

export * as api from './api.ts'
export {
  ASSETS, TRANSFER_ENDPOINT, TRANSFER_PAGE, assetUrls, buildTransferUrl, normalizeGroupCode, runAuthorize,
  validateIdentity, type AuthorizeDeps, type AuthorizeIo,
} from './authorize.ts'
export { DEFAULT_EXCLUDE, collectEntries, generateItems, matchPattern, pickLabel, truncate, type CommandEntry, type GenerateOptions } from './commands.ts'
export { COMMAND_SOURCES, Config, SESSION_COMMANDS, type AuthorizeConfig, type CommandConfig, type PanelConfig } from './config.ts'
export {
  BY, QqPanelHost, STATUS_ONLINE, describeMenuItems, describePanelRecords, formatResult, groupOpenIdOf, isQqBot,
  managementCommand, parseInvocation, requestOf,
  type HostDeps, type InspectReport, type Invocation, type MessageEventLike, type MessageLike, type PanelResult,
  type QqBotLike, type SlashSkillLike, type SyncOptions, type SyncResult,
} from './host.ts'
export { QQ_PANEL_TAB, applyPanel, qqPanelTab, type PanelHost, type PanelTabDefinition, type QqPanelTabState } from './panel.ts'
export * from './sync.ts'

/** Plugin identity. */
export const name = 'im-qq-panel'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** QQ custom menu and command panels: inspection, sync and the platform client. */
    qqPanel: QqPanelService
  }
}

/** The plugin as a service (`ctx.qqPanel`). */
export class QqPanelService extends Service {
  static inject = ['im']
  static Config = Config

  /** The behaviour behind this service. */
  readonly host: QqPanelHost
  private readonly home: Context

  constructor(ctx: Context, config: Config) {
    super(ctx, 'qqPanel')
    this.home = ctx
    this.host = new QqPanelHost(config, {
      // `bots` is a mixin of the IM core's `satori` service; read the service so no extra injection is needed.
      bots: () => (ctx.get('satori') as { bots?: readonly unknown[] } | undefined)?.bots ?? [],
      skills: () => {
        const dispatch = ctx.get('imDispatch') as { skills?: () => Promise<SlashSkillLike[]> } | undefined
        return typeof dispatch?.skills === 'function' ? dispatch.skills() : undefined
      },
      logger: ctx.logger('qq-panel'),
    })
  }

  async* [Service.init](): AsyncGenerator<() => void, void> {
    const ctx = this.home
    const host = this.host
    yield () => { host.dispose() }
    ctx.on('im/message', (event: ImMessageEvent, next: () => Promise<ImOutcome>) => host.handle(
      event as unknown as MessageEventLike,
      next as unknown as () => Promise<OutcomeLike>,
    ) as Promise<ImOutcome>, { prepend: true })
    ctx.on('login-added', (session) => { host.onBotStatus(session.bot) })
    ctx.on('login-updated', (session) => { host.onBotStatus(session.bot) })
    ctx.on('skills/change' as never, (() => { host.onSkillsChanged() }) as never)
    for (const bot of host.bots()) host.onBotStatus(bot)
    applyPanel(ctx, host)
  }

  /** The managed QQ bots. */
  bots(): QqBotLike[] { return this.host.bots() }

  /**
   * Read the platform and compare it with the configuration; writes nothing.
   * @param options - the bot (default: the first online one).
   */
  inspect(options?: { bot?: QqBotLike }): Promise<InspectReport> { return this.host.inspect(options) }

  /**
   * Align the platform with the configuration.
   * @param options - bot, resources and dry run.
   */
  sync(options?: SyncOptions): Promise<SyncResult> { return this.host.sync(options) }

  /**
   * The menu / panel operations of one bot, bound to its adapter's client.
   * @param bot - the bot (default: the first online one).
   */
  client(bot?: QqBotLike): ReturnType<QqPanelHost['client']> { return this.host.client(bot) }
}

export default QqPanelService
