/**
 * The behaviour of the plugin, independent of cordis so tests drive it with plain fakes: which QQ bots exist, the
 * desired menu and panels (configuration + command sources), inspection and sync against the platform, the
 * management commands and the authorization command on `im/message`, and the automatic sync.
 *
 * @module dsh-im-qq-panel/host
 */

import type { Fragment } from '@deepseek-ai/cordis-plugin-im-core'
import * as api from './api.ts'
import { assetUrls, runAuthorize, type AssetKey } from './authorize.ts'
import { generateItems, type CommandEntry } from './commands.ts'
import type { Config, PanelConfig } from './config.ts'
import {
  matchPanels, normalizePanelConfig, planMenu, planPanels,
  type DesiredPanel, type MenuPlan, type PanelAction,
} from './sync.ts'

/** `Status.ONLINE` of the IM core. */
export const STATUS_ONLINE = 1

/** Outcome attribution of a handled message. */
export const BY = 'qq-panel'

/** The part of a QQ adapter bot this plugin uses: its id, status and authenticated REST client. */
export interface QqBotLike {
  readonly id: string
  readonly platform: string
  readonly status: number
  readonly api: {
    request(method: string, path: string, options?: { data?: unknown; signal?: AbortSignal }): Promise<unknown>
  }
}

/** Whether a bot is a QQ adapter bot with a REST client this plugin can use. */
export function isQqBot(bot: unknown): bot is QqBotLike {
  const value = bot as Partial<QqBotLike> | undefined
  return !!value && value.platform === 'qq' && typeof value.id === 'string'
    && typeof value.api === 'object' && value.api !== null && typeof value.api.request === 'function'
}

/** The transport of one bot: its adapter's own authenticated client. */
export function requestOf(bot: QqBotLike): api.QqRequest {
  return (method, path, data) => bot.api.request(method, path, data === undefined ? {} : { data })
}

/** A slash skill as `ctx.imDispatch.skills()` lists it. */
export interface SlashSkillLike {
  name: string
  description: string
  commands: readonly string[]
}

/** Logger. */
export interface LoggerLike {
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
}

/** What the host reads from its surroundings. */
export interface HostDeps {
  /** Every mounted bot (filtered here). */
  bots(): readonly unknown[]
  /** The dispatch `/skill` list, when `dsh-im-dispatch` is mounted. */
  skills?(): Promise<readonly SlashSkillLike[]> | undefined
  logger: LoggerLike
  /** Image URLs of the authorization guides; default the packaged files. */
  images?: Partial<Record<AssetKey, string>>
  /** Timer (tests replace it). */
  setTimeout?(callback: () => void, ms: number): () => void
}

/** A read-only comparison of configuration and platform. */
export interface InspectReport {
  bot: string
  menu: {
    remote: { version: number; menu: { items?: unknown[] } }
    desired: api.Menu
    managed: boolean
    plan: MenuPlan
  }
  desired: { key: string; scope: string; targetType: string; source: string; remark: string; labels: string[] }[]
  records: api.PanelRecord[]
  panels: PanelAction[]
  warnings: string[]
}

/** One entry of a sync result. */
export interface PanelResult {
  action: 'created' | 'updated' | 'unchanged' | 'recreated' | 'deleted' | 'target-added' | 'target-removed' | 'skipped' | 'failed' | 'dry-run'
  key?: string
  panelId?: string
  type?: string
  reason?: string
  error?: string
  count?: number
}

/** What a sync did. */
export interface SyncResult {
  bot: string
  dryRun: boolean
  /** What was synced. */
  resources: readonly ('menu' | 'panels')[]
  menu: { action: string; version?: number; itemCount?: number; from?: number; to?: number; reason?: string; error?: string } | null
  panels: PanelResult[]
  warnings: string[]
  failures: string[]
}

/** Options of a sync. */
export interface SyncOptions {
  bot?: QqBotLike
  resources?: readonly ('menu' | 'panels')[]
  dryRun?: boolean
}

const ACTION_LABELS: Record<string, string> = {
  created: '新建',
  updated: '更新',
  unchanged: '无需修改',
  recreated: '重建',
  deleted: '删除',
  'target-added': '补充关联对象',
  'target-removed': '移除关联对象',
  skipped: '跳过',
  failed: '失败',
  create: '新建',
  recreate: '重建',
  update: '更新',
  target: '关联对象',
  delete: '删除',
}

// ---------------------------------------------------------------------------------------------------------------
// Message side

/** The part of a stored IM message the commands read. */
export interface MessageLike {
  key: string
  text: string
  addressed: boolean
  command?: { name: string; rawInput: string }
  chat: { key?: string; bot: string; ref: { id: string; type?: string } }
  sender: { id: string }
}

/** The part of the `im/message` event the commands use. */
export interface MessageEventLike {
  readonly message: MessageLike
  readonly bot: unknown
  reply(content: Fragment, options?: { operationId?: string }): Promise<{ status: string } | undefined>
}

/** Outcome of the waterfall. */
export type OutcomeLike = { kind: 'handled'; by: string } | { kind: 'ignored'; reason?: string } | { kind: string; [key: string]: unknown }

/** A slash invocation: name and the text after it. */
export interface Invocation {
  name: string
  args: string
}

/**
 * Read a slash invocation from a message: the core's parsed `command` when there is one (ASCII names), else the
 * text after leading `@mentions` (`/授权全消息 123`, `／qq面板` — the core parses only ASCII names).
 * @param message - the stored message.
 */
export function parseInvocation(message: Pick<MessageLike, 'text' | 'command'>): Invocation | undefined {
  if (message.command) return { name: message.command.name, args: message.command.rawInput.trim() }
  const text = String(message.text ?? '').trim().replace(/^(?:@\S+\s*)+/, '')
  const match = /^[/／](\S+)(?:\s+([\s\S]*))?$/.exec(text)
  if (!match) return undefined
  return { name: match[1]!, args: (match[2] ?? '').trim() }
}

type Management = 'menu' | 'menu.sync' | 'panel' | 'panel.sync' | 'panel.group' | 'panel.delete' | 'sync'

const MANAGEMENT: Record<string, Management> = {
  'qqmenu': 'menu',
  'qq菜单': 'menu',
  'qqmenu.sync': 'menu.sync',
  'qq菜单同步': 'menu.sync',
  'qqpanel': 'panel',
  'qq面板': 'panel',
  'qqpanel.sync': 'panel.sync',
  'qq面板同步': 'panel.sync',
  'qqpanel.group': 'panel.group',
  '面板群号': 'panel.group',
  'qqpanel.delete': 'panel.delete',
  'qq面板删除': 'panel.delete',
  'qqsync': 'sync',
  'qq同步': 'sync',
}

const SUBCOMMANDS: Record<string, Partial<Record<string, Management>>> = {
  menu: { sync: 'menu.sync', '同步': 'menu.sync' },
  panel: { sync: 'panel.sync', '同步': 'panel.sync', group: 'panel.group', '群号': 'panel.group', delete: 'panel.delete', '删除': 'panel.delete' },
}

/**
 * Resolve a management command, including the space form (`/qqpanel sync`).
 * @param invocation - the parsed invocation.
 * @returns the command and its remaining argument.
 */
export function managementCommand(invocation: Invocation): { command: Management; args: string } | undefined {
  const command = MANAGEMENT[invocation.name.toLowerCase()]
  if (command === undefined) return undefined
  const [head = '', ...rest] = invocation.args.split(/\s+/)
  const sub = SUBCOMMANDS[command]?.[head.toLowerCase()]
  if (sub !== undefined) return { command: sub, args: rest.join(' ').trim() }
  return { command, args: invocation.args }
}

/** The openid of a group chat id (`group:<openid>`), else undefined. */
export function groupOpenIdOf(chatId: string): string | undefined {
  return chatId.startsWith('group:') ? chatId.slice('group:'.length) : undefined
}

// ---------------------------------------------------------------------------------------------------------------

/** The plugin's behaviour. */
export class QqPanelHost {
  private readonly images: Partial<Record<AssetKey, string>>
  private readonly synced = new Set<string>()
  private readonly timers = new Set<() => void>()
  private disposed = false
  private resyncTimer: (() => void) | undefined

  constructor(readonly config: Config, private readonly deps: HostDeps) {
    this.images = deps.images ?? assetUrls()
  }

  /** Stop timers; later automatic syncs do nothing. */
  dispose(): void {
    this.disposed = true
    for (const cancel of this.timers) cancel()
    this.timers.clear()
    this.resyncTimer = undefined
  }

  // -------------------------------------------------------------------------------------------------------------
  // Bots

  /** Every QQ bot this plugin manages (`botId` narrows to one). */
  bots(): QqBotLike[] {
    return this.deps.bots().filter(isQqBot).filter(bot => !this.config.botId || bot.id === this.config.botId)
  }

  /** The managed bots that are online. */
  onlineBots(): QqBotLike[] {
    return this.bots().filter(bot => bot.status === STATUS_ONLINE)
  }

  /**
   * The bot to act with: the given one, else the first online managed bot.
   * @param bot - an explicit bot.
   * @throws Error when no managed bot is online.
   */
  requireBot(bot?: QqBotLike): QqBotLike {
    if (bot) return bot
    const online = this.onlineBots()
    if (!online.length) throw new Error('没有在线的 QQ 机器人：适配器上线后菜单/面板接口才可用')
    return online[0]!
  }

  /**
   * The platform client of one bot: the `api.ts` operations bound to its transport.
   * @param bot - the bot; default {@link requireBot}.
   */
  client(bot?: QqBotLike) {
    const request = requestOf(this.requireBot(bot))
    return {
      request,
      getMenu: () => api.getMenu(request),
      updateMenu: (menu: unknown) => api.updateMenu(request, menu),
      getPanels: (params: { scope: string; cursor?: string; limit?: number }) => api.getPanels(request, params),
      getAllPanels: (scope: string) => api.getAllPanels(request, scope),
      createPanel: (input: unknown) => api.createPanel(request, input),
      getPanel: (panelId: string) => api.getPanel(request, panelId),
      updatePanel: (panelId: string, panel: unknown) => api.updatePanel(request, panelId, panel),
      deletePanel: (panelId: string) => api.deletePanel(request, panelId),
      updatePanelTarget: (panelId: string, input: unknown) => api.updatePanelTarget(request, panelId, input),
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Desired state

  /** The configured menu in platform shape. */
  desiredMenu(): api.Menu {
    return api.normalizeMenu(this.config.menu)
  }

  /** Every command entry the sources offer, with warnings for sources that failed. */
  async commandEntries(): Promise<{ entries: CommandEntry[]; warnings: string[] }> {
    const warnings: string[] = []
    const entries: CommandEntry[] = []
    for (const entry of this.config.commands.session) entries.push({ ...entry, source: 'session' })
    if (this.config.commands.skills && this.deps.skills) {
      try {
        const skills = await this.deps.skills()
        for (const skill of skills ?? []) {
          entries.push({ name: skill.name, aliases: [...skill.commands], description: skill.description, source: 'skills' })
        }
      } catch (error) {
        warnings.push(`读取 /skill 命令失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    for (const entry of this.config.commands.extra) entries.push({ ...entry, source: 'extra' })
    return { entries, warnings }
  }

  /** The configured panels in platform shape, generated panels resolved. */
  async desiredPanels(): Promise<{ panels: DesiredPanel[]; warnings: string[] }> {
    const remarks = new Set<string>()
    const panelIds = new Set<string>()
    const needsCommands = this.config.panels.some(panel => panel.source === 'commands')
    const gathered = needsCommands ? await this.commandEntries() : { entries: [], warnings: [] }
    const warnings = [...gathered.warnings]
    const panels = this.config.panels.map((item, index) => {
      const resolved = this.resolveItems(item, index, gathered.entries, warnings)
      const panel = normalizePanelConfig(item, index, { remarkPrefix: this.config.remarkPrefix, items: resolved })
      panel.source = item.source
      if (remarks.has(panel.remark)) throw new Error(`面板 #${index + 1} 的备注与前面的面板重复：${panel.remark}`)
      remarks.add(panel.remark)
      if (panel.panelId) {
        if (panelIds.has(panel.panelId)) throw new Error(`面板 #${index + 1} 绑定了重复的 panel_id：${panel.panelId}`)
        panelIds.add(panel.panelId)
      }
      return panel
    })
    return { panels, warnings }
  }

  private resolveItems(item: PanelConfig, index: number, entries: readonly CommandEntry[], warnings: string[]): unknown[] {
    if (item.source === 'manual') return item.items
    const sources = new Set<string>(item.sources)
    const generated = generateItems(entries.filter(entry => sources.has(entry.source)), {
      prefix: item.prefix ?? this.config.commandPrefix,
      include: item.include,
      exclude: item.exclude,
      maxItems: item.maxItems,
      extraItems: item.extraItems,
    })
    for (const warning of generated.warnings) warnings.push(`面板 #${index + 1}（${item.key}）：${warning}`)
    return generated.items
  }

  // -------------------------------------------------------------------------------------------------------------
  // Inspect and sync

  /**
   * Read the platform and compare it with the configuration; writes nothing.
   * @param options - the bot.
   */
  async inspect(options: { bot?: QqBotLike } = {}): Promise<InspectReport> {
    const bot = this.requireBot(options.bot)
    const request = requestOf(bot)
    const menu = this.desiredMenu()
    const desired = await this.desiredPanels()
    const remoteMenu = await api.getMenu(request)

    const scopes = new Set<string>(desired.panels.map(panel => panel.scope))
    if (this.config.prune) for (const scope of api.PANEL_SCOPES) scopes.add(scope)
    const records: api.PanelRecord[] = []
    const seen = new Set<string>()
    for (const scope of scopes) {
      for (const record of await api.getAllPanels(request, scope)) {
        if (!record?.panel_id || seen.has(record.panel_id)) continue
        seen.add(record.panel_id)
        records.push(record)
      }
    }
    const matches = matchPanels(desired.panels, records)
    const details = new Map<string, api.PanelDetail>()
    for (const { panel, record } of matches) {
      if (!record || panel.targetType !== 'specific' || record.target_type !== 'specific') continue
      if (details.has(record.panel_id)) continue
      details.set(record.panel_id, await api.getPanel(request, record.panel_id))
    }
    return {
      bot: bot.id,
      menu: {
        remote: remoteMenu,
        desired: menu,
        managed: menu.items.length > 0 || this.config.allowEmptyMenu,
        plan: planMenu(remoteMenu, menu),
      },
      desired: desired.panels.map(panel => ({
        key: panel.key,
        scope: panel.scope,
        targetType: panel.targetType,
        source: panel.source ?? 'manual',
        remark: panel.remark,
        labels: panel.panel.items.map(entry => (entry.type === 'link' ? `${entry.name}（${entry.link}）` : entry.name)),
      })),
      records,
      panels: planPanels({ matches, details, records, remarkPrefix: this.config.remarkPrefix, prune: this.config.prune }),
      warnings: desired.warnings,
    }
  }

  /**
   * Read, compare and write what differs. A rate-limit answer stops the remaining panel writes of this run.
   * @param options - bot, resources (`menu` / `panels`) and dry run.
   */
  async sync(options: SyncOptions = {}): Promise<SyncResult> {
    const bot = this.requireBot(options.bot)
    const request = requestOf(bot)
    const dryRun = options.dryRun ?? this.config.dryRun
    const resources = options.resources ?? ['menu', 'panels']
    const report = await this.inspect({ bot })
    const result: SyncResult = { bot: bot.id, dryRun, resources, menu: null, panels: [], warnings: [...report.warnings], failures: [] }

    if (resources.includes('menu')) {
      const info = report.menu
      if (!info.managed) {
        result.menu = { action: 'skipped', version: info.remote.version, reason: '配置未提供菜单项且 allowEmptyMenu=false，未改动平台菜单' }
      } else if (!info.plan.changed) {
        result.menu = { action: 'unchanged', version: info.remote.version, itemCount: info.plan.desiredItemCount }
      } else if (dryRun) {
        result.menu = { action: 'dry-run', version: info.remote.version, from: info.plan.remoteItemCount, to: info.plan.desiredItemCount }
      } else {
        try {
          const updated = await api.updateMenu(request, info.desired)
          result.menu = { action: 'updated', version: updated.version, from: info.plan.remoteItemCount, to: info.plan.desiredItemCount }
          this.deps.logger.info('QQ 自定义菜单已更新：%d -> %d 项，版本 %s', info.plan.remoteItemCount, info.plan.desiredItemCount, updated.version)
        } catch (error) {
          const message = api.describeError(error)
          result.menu = { action: 'failed', error: message }
          result.failures.push(`菜单下发失败：${message}`)
          if (api.isRateLimited(error)) result.warnings.push('平台对菜单写入限频（5 次/分钟），稍后再同步即可')
        }
      }
    }

    if (resources.includes('panels')) {
      let blocked = false
      for (const action of report.panels) {
        const key = 'panel' in action ? action.panel.key : action.remark
        const panelId = 'panelId' in action ? action.panelId : undefined
        if (action.type === 'unchanged') {
          result.panels.push({ action: 'unchanged', key, panelId: action.panelId })
          continue
        }
        if (action.type === 'warn') {
          result.panels.push({ action: 'skipped', key })
          result.warnings.push(action.message)
          continue
        }
        if (blocked) {
          result.panels.push({ action: 'skipped', key, ...panelId ? { panelId } : {}, reason: '平台限频' })
          continue
        }
        if (dryRun) {
          result.panels.push({ action: 'dry-run', type: action.type, key, ...panelId ? { panelId } : {} })
          continue
        }
        try {
          await this.apply(request, action, result)
        } catch (error) {
          const message = api.describeError(error)
          result.panels.push({ action: 'failed', type: action.type, key, ...panelId ? { panelId } : {}, error: message })
          result.failures.push(`${action.type} ${key} 失败：${message}`)
          this.deps.logger.warn('QQ 面板同步动作失败（%s %s）：%s', action.type, key, message)
          if (api.isRateLimited(error)) {
            blocked = true
            result.warnings.push('平台对面板写入限频（10 次/分钟），本次剩余动作已跳过，请稍后再同步')
          }
        }
      }
    }
    return result
  }

  private async apply(request: api.QqRequest, action: PanelAction, result: SyncResult): Promise<void> {
    const logger = this.deps.logger
    switch (action.type) {
      case 'create':
      case 'recreate': {
        if (action.type === 'recreate') await api.deletePanel(request, action.panelId)
        const payload: api.PanelCreate = { scope: action.panel.scope, target_type: action.panel.targetType, panel: action.panel.panel }
        if (action.panel.userOpenIds.length) payload.user_openids = action.panel.userOpenIds
        if (action.panel.groupOpenIds.length) payload.group_openids = action.panel.groupOpenIds
        const created = await api.createPanel(request, payload)
        result.panels.push({
          action: action.type === 'recreate' ? 'recreated' : 'created',
          key: action.panel.key,
          panelId: created.panelId,
          ...action.type === 'recreate' ? { reason: action.reason } : {},
        })
        logger.info('QQ 指令面板已%s：%s -> %s（%s，%d 项：%s）', action.type === 'recreate' ? '重建' : '创建',
          action.panel.key, created.panelId, action.panel.scope, action.panel.panel.items.length, summarizeItems(action.panel.panel.items))
        return
      }
      case 'update':
        await api.updatePanel(request, action.panelId, action.panel.panel)
        result.panels.push({ action: 'updated', key: action.panel.key, panelId: action.panelId })
        logger.info('QQ 指令面板已更新：%s -> %s（%d 项：%s）', action.panel.key, action.panelId,
          action.panel.panel.items.length, summarizeItems(action.panel.panel.items))
        return
      case 'target': {
        const field = action.scope === 'group' ? 'group_openids' : 'user_openids'
        // The platform takes at most 20 openids per request.
        for (let index = 0; index < action.openIds.length; index += api.LIMITS.openIdsPerRequest) {
          await api.updatePanelTarget(request, action.panelId, { op: action.op, [field]: action.openIds.slice(index, index + api.LIMITS.openIdsPerRequest) })
        }
        result.panels.push({
          action: action.op === 'add' ? 'target-added' : 'target-removed',
          key: action.panel.key,
          panelId: action.panelId,
          count: action.openIds.length,
        })
        logger.info('QQ 指令面板 %s 关联对象已%s %d 个', action.panelId, action.op === 'add' ? '补充' : '移除', action.openIds.length)
        return
      }
      case 'delete':
        await api.deletePanel(request, action.panelId)
        result.panels.push({ action: 'deleted', key: action.remark, panelId: action.panelId })
        logger.info('QQ 指令面板已删除：%s（%s）', action.panelId, action.remark)
        return
      default:
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Automatic sync

  /**
   * A bot changed state: schedule the automatic sync of an online managed bot not yet synced by this process.
   * @param bot - the bot of a login event.
   */
  onBotStatus(bot: unknown): void {
    if (this.disposed || !this.config.autoSync || !isQqBot(bot)) return
    if (this.config.botId && bot.id !== this.config.botId) return
    if (bot.status !== STATUS_ONLINE) {
      this.synced.delete(bot.id)
      return
    }
    if (this.synced.has(bot.id)) return
    this.synced.add(bot.id)
    this.later(this.config.autoSyncDelayMs, () => { void this.autoSync(bot.id, 'online') })
  }

  /** The skill catalog changed: re-sync the panels of the synced bots (debounced). */
  onSkillsChanged(): void {
    if (this.disposed || !this.config.autoSync || !this.config.resyncOnSkillChange) return
    if (!this.config.panels.some(panel => panel.source === 'commands' && panel.sources.includes('skills'))) return
    this.resyncTimer?.()
    this.resyncTimer = this.later(Math.max(this.config.autoSyncDelayMs, 10000), () => {
      this.resyncTimer = undefined
      for (const bot of this.onlineBots()) {
        if (this.synced.has(bot.id)) void this.autoSync(bot.id, 'skills', ['panels'])
      }
    })
  }

  /**
   * One automatic sync of one bot; a failure is logged and lets the next login event retry.
   * @param botId - the bot.
   * @param reason - for the log.
   * @param resources - what to sync.
   */
  async autoSync(botId: string, reason: string, resources?: readonly ('menu' | 'panels')[]): Promise<SyncResult | undefined> {
    if (this.disposed) return undefined
    const bot = this.onlineBots().find(candidate => candidate.id === botId)
    if (!bot) {
      this.synced.delete(botId)
      return undefined
    }
    try {
      const result = await this.sync({ bot, ...resources ? { resources } : {} })
      if (!this.disposed) this.deps.logger.info('QQ 菜单/面板自动同步完成（%s）：%s', reason, formatResult(result).replace(/\n/g, '；'))
      return result
    } catch (error) {
      this.synced.delete(botId)
      this.deps.logger.warn('QQ 菜单/面板自动同步失败（%s）：%s', reason, api.describeError(error))
      return undefined
    }
  }

  private later(ms: number, callback: () => void): () => void {
    const schedule = this.deps.setTimeout ?? ((run: () => void, delay: number) => {
      const handle = setTimeout(run, delay)
      return () => clearTimeout(handle)
    })
    let cancel: () => void = () => {}
    const wrapped = (): void => {
      this.timers.delete(cancel)
      if (!this.disposed) callback()
    }
    cancel = schedule(wrapped, ms)
    this.timers.add(cancel)
    return () => {
      cancel()
      this.timers.delete(cancel)
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Commands

  /**
   * Whether a sender may run the management commands.
   * @param message - the message.
   */
  isManager(message: Pick<MessageLike, 'sender' | 'chat'>): boolean {
    const sender = message.sender.id
    return this.config.admins.includes(sender) || this.config.admins.includes(`${message.chat.bot}|${sender}`)
  }

  /** Whether an invocation names the authorization command. */
  private isAuthorize(name: string): boolean {
    const options = this.config.authorize
    if (!options.enabled) return false
    const lower = name.toLowerCase()
    return [options.command, ...options.aliases].some(candidate => candidate.toLowerCase() === lower)
  }

  /**
   * The `im/message` listener: the management commands and the authorization command; everything else passes on.
   * @param event - the admitted message.
   * @param next - the rest of the waterfall.
   */
  async handle(event: MessageEventLike, next: () => Promise<OutcomeLike>): Promise<OutcomeLike> {
    const { message } = event
    if (!message.addressed) return next()
    const invocation = parseInvocation(message)
    if (!invocation) return next()
    let sequence = 0
    const reply = async (content: Fragment): Promise<boolean> => {
      sequence += 1
      const sent = await event.reply(content, { operationId: `${BY}:${message.key}:${sequence}` })
      return sent === undefined || sent.status !== 'failed'
    }

    if (this.isAuthorize(invocation.name)) {
      const platform = (event.bot as { platform?: string } | undefined)?.platform ?? ''
      const failure = await runAuthorize({ platform, send: reply }, invocation.args, {
        options: this.config.authorize,
        images: this.images,
        logger: this.deps.logger,
      })
      if (failure) await reply(failure)
      return { kind: 'handled', by: BY }
    }

    const management = managementCommand(invocation)
    if (!management) return next()
    if (!this.isManager(message)) {
      await reply('你没有管理 QQ 菜单/面板的权限。')
      return { kind: 'handled', by: BY }
    }
    let text: string
    try {
      text = await this.runManagement(management.command, management.args, event)
    } catch (error) {
      text = `操作失败：${api.describeError(error)}`
    }
    await reply(text)
    return { kind: 'handled', by: BY }
  }

  /** The bot a management command acts with: the receiving bot when it is a managed QQ bot. */
  private botFor(event: MessageEventLike): QqBotLike {
    const bot = event.bot
    if (isQqBot(bot) && (!this.config.botId || bot.id === this.config.botId)) return bot
    return this.requireBot()
  }

  private async runManagement(command: Management, args: string, event: MessageEventLike): Promise<string> {
    switch (command) {
      case 'menu': return await this.describeMenu(this.botFor(event))
      case 'menu.sync': return formatResult(await this.sync({ bot: this.botFor(event), resources: ['menu'] }))
      case 'panel': return await this.describePanels(this.botFor(event))
      case 'panel.sync': return formatResult(await this.sync({ bot: this.botFor(event), resources: ['panels'] }))
      case 'panel.group': return this.describeGroup(event.message)
      case 'panel.delete': {
        const panelId = args.split(/\s+/)[0] ?? ''
        if (!panelId) return '用法：/qqpanel.delete <panel_id>'
        await api.deletePanel(requestOf(this.botFor(event)), panelId)
        return `已删除面板 ${panelId}。`
      }
      case 'sync': return formatResult(await this.sync({ bot: this.botFor(event) }))
    }
  }

  /** `/qqmenu`: the platform menu and how the configuration differs. */
  async describeMenu(bot?: QqBotLike): Promise<string> {
    const target = this.requireBot(bot)
    const remote = await api.getMenu(requestOf(target))
    const desired = this.desiredMenu()
    const plan = planMenu(remote, desired)
    const lines = [
      `机器人 ${target.id}｜平台菜单版本 ${remote.version}，当前 ${(remote.menu.items ?? []).length} 项`,
      describeMenuItems(remote.menu),
    ]
    if (!desired.items.length && !this.config.allowEmptyMenu) lines.push('配置未提供菜单项（allowEmptyMenu=false），不会改动平台菜单')
    else if (!plan.changed) lines.push(`配置与平台一致（${plan.desiredItemCount} 项），无需下发`)
    else lines.push(`配置与平台不一致：${plan.remoteItemCount} -> ${plan.desiredItemCount} 项，可用 /qqmenu.sync 下发`)
    return lines.join('\n')
  }

  /** `/qqpanel`: the platform panels, the configured ones and the pending actions. */
  async describePanels(bot?: QqBotLike): Promise<string> {
    const report = await this.inspect(bot ? { bot } : {})
    const lines = [`机器人 ${report.bot}｜平台生效面板 ${report.records.length} 个`, describePanelRecords(report.records)]
    if (!report.desired.length) lines.push('配置中没有面板（在插件配置 panels 里添加 c2c/group/channel/dm 面板）')
    for (const panel of report.desired) {
      lines.push(`配置面板 ${panel.key}｜${panel.scope}｜${panel.targetType}｜来源 ${panel.source}｜${panel.labels.length} 项`)
      if (panel.labels.length) lines.push(panel.labels.join('、'))
    }
    const pending = report.panels.filter(action => action.type !== 'unchanged' && action.type !== 'warn')
    if (!pending.length) lines.push('配置与平台一致，无需下发')
    else lines.push(`待处理动作 ${pending.length} 个：${pending.map(action => ACTION_LABELS[action.type] ?? action.type).join('、')}（用 /qqpanel.sync 下发）`)
    for (const warning of report.warnings) lines.push(`警告：${warning}`)
    return lines.join('\n')
  }

  /** `/qqpanel.group`: the openid of the current group and which configured group panels cover it. */
  describeGroup(message: Pick<MessageLike, 'chat'>): string {
    const openId = groupOpenIdOf(message.chat.ref.id)
    if (openId === undefined) return '请在目标 QQ 群里使用该命令。'
    const lines = [`当前群 OpenID：${openId}`]
    const panels = this.config.panels.filter(item => item.scope === 'group')
    if (!panels.length) lines.push('配置中没有 group 场景面板。')
    for (const item of panels) {
      const specific = item.targetType === 'specific'
      const matched = !specific || item.groupOpenIds.includes(openId)
      lines.push(`- ${item.key}：${specific ? (matched ? '指定生效（含本群）' : '指定生效（不含本群）') : '全群生效'}`)
    }
    lines.push('把该 OpenID 填进面板的 groupOpenIds 并把 targetType 设为 specific，即可让不同群显示不同指令面板。')
    return lines.join('\n')
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Formatting

/** Item names (links with their address), joined. */
export function summarizeItems(items: readonly api.PanelItem[]): string {
  return items.map(entry => (entry.type === 'link' ? `${entry.name}（${entry.link}）` : entry.name)).join('、')
}

/** The platform menu, one line per item. */
export function describeMenuItems(menu: { items?: unknown[] } | undefined): string {
  const items = (menu?.items ?? []) as api.MenuItem[]
  if (!items.length) return '（平台当前没有菜单项）'
  return items.map((item, index) => {
    const extra = item.type === 'send_message' ? item.send_message
      : item.type === 'link' ? item.link
        : item.type === 'switch' ? `switch_id=${item.switch?.switch_id}`
          : `${(item.sub_menu_items ?? []).length} 个子项`
    return `${index + 1}. [${item.type}] ${item.name}${extra ? ` → ${extra}` : ''}`
  }).join('\n')
}

/** The platform panels, one line each. */
export function describePanelRecords(records: readonly api.PanelRecord[]): string {
  if (!records.length) return '（平台当前没有已生效的指令面板）'
  return records.map((record) => {
    const items = record.panel?.items ?? []
    const remark = record.panel?.remark || '-'
    return `${record.panel_id}｜${record.scope}｜${record.target_type}｜${items.length} 项｜v${record.version ?? '-'}｜${remark}`
  }).join('\n')
}

/** A sync result as a few lines of text. */
export function formatResult(result: SyncResult): string {
  const lines: string[] = []
  if (result.dryRun) lines.push('（演练模式：未向平台提交任何修改）')
  if (result.menu) {
    const info = result.menu
    if (info.action === 'unchanged') lines.push(`菜单：无需修改（${info.itemCount} 项，版本 ${info.version}）`)
    else if (info.action === 'skipped') lines.push(`菜单：跳过（${info.reason}）`)
    else if (info.action === 'dry-run') lines.push(`菜单：待更新（${info.from} -> ${info.to} 项，当前版本 ${info.version}）`)
    else if (info.action === 'updated') lines.push(`菜单：已更新（${info.from} -> ${info.to} 项，版本 ${info.version}）`)
    else lines.push(`菜单：失败（${info.error}）`)
  }
  const counts = new Map<string, number>()
  for (const item of result.panels) {
    const key = item.action === 'dry-run' ? `演练:${ACTION_LABELS[item.type ?? ''] ?? item.type ?? ''}` : (ACTION_LABELS[item.action] ?? item.action)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  if (counts.size) lines.push(`面板：${[...counts].map(([key, value]) => `${key} ${value}`).join('、')}`)
  else if (result.resources.includes('panels')) lines.push('面板：配置中没有需要同步的面板')
  for (const warning of result.warnings) lines.push(`警告：${warning}`)
  for (const failure of result.failures) lines.push(`失败：${failure}`)
  return lines.join('\n')
}
