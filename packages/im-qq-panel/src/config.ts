/**
 * Configuration of the plugin row (zod, which cordis accepts as a Standard Schema: the row is validated and given its
 * defaults before the plugin starts).
 *
 * Item contents (menu items, panel items) are kept loose here and validated by `api.ts` against the platform rules,
 * so a mistake is reported in the platform's terms (“菜单项 #2 名称超长 …”) by the sync that would send it.
 *
 * @module dsh-im-qq-panel/config
 */

import { z } from 'zod'
import { MENU_ITEM_TYPES, PANEL_ITEM_TYPES, PANEL_SCOPES, PANEL_TARGET_TYPES, SUB_MENU_ITEM_TYPES } from './api.ts'

const subMenuItem = z.object({
  type: z.enum(SUB_MENU_ITEM_TYPES).default('send_message'),
  name: z.string(),
  sendMessage: z.string().optional(),
  link: z.string().optional(),
})

const menuItem = z.object({
  type: z.enum(MENU_ITEM_TYPES).default('send_message'),
  /** At most 10 characters (CJK counts 2). */
  name: z.string(),
  /** `send_message`: the text a tap puts into the input box. */
  sendMessage: z.string().optional(),
  /** `link`: an `https://` address. */
  link: z.string().optional(),
  /** `switch`: the switch id the platform reports back. */
  switchId: z.string().optional(),
  switchDefault: z.boolean().optional(),
  /** `menu`: 1–5 sub-items. */
  subMenuItems: z.array(subMenuItem).optional(),
})

const panelItem = z.object({
  type: z.enum(PANEL_ITEM_TYPES).default('command'),
  /** `command`: also the text a tap puts into the input box (≤ 14). */
  name: z.string(),
  /** ≤ 30. */
  desc: z.string().optional(),
  /** `link`: an `https://` address. */
  link: z.string().optional(),
  onlyAdmin: z.boolean().default(false),
})

/** One command a panel may list, as configured. */
const commandEntry = z.object({
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  description: z.string().optional(),
  onlyAdmin: z.boolean().default(false),
})

/** The built-in commands of `dsh-im-session-commands` (it does not publish its list). */
export const SESSION_COMMANDS = [
  { name: 'help', aliases: [], description: '显示可用命令', onlyAdmin: false },
  { name: 'status', aliases: [], description: '查看会话状态', onlyAdmin: false },
  { name: 'new', aliases: [], description: '开启新会话（重置上下文）', onlyAdmin: false },
  { name: 'clear', aliases: [], description: '清空会话（重置上下文）', onlyAdmin: false },
  { name: 'stop', aliases: [], description: '停止正在运行的会话', onlyAdmin: false },
]

/** Command sources a generated panel can draw from. */
export const COMMAND_SOURCES = ['session', 'skills', 'extra'] as const

const panel = z.object({
  /** Local id; the panel's remark is `<remarkPrefix><key>` and remote panels are matched by it. */
  key: z.string(),
  scope: z.enum(PANEL_SCOPES).default('c2c'),
  /** `specific` (c2c / group only) needs `userOpenIds` / `groupOpenIds`. */
  targetType: z.enum(PANEL_TARGET_TYPES).default('all'),
  userOpenIds: z.array(z.string()).default([]),
  groupOpenIds: z.array(z.string()).default([]),
  /** Bind an existing remote panel by id instead of by remark. */
  panelId: z.string().optional(),
  /** Platform remark; default `<remarkPrefix><key>`. */
  remark: z.string().optional(),
  /** `commands`: generated from the command sources; `manual`: `items`. */
  source: z.enum(['commands', 'manual']).default('commands'),
  /** `source: commands`: which command sources to draw from. */
  sources: z.array(z.enum(COMMAND_SOURCES)).default([...COMMAND_SOURCES]),
  /** `source: commands`: listed first, in this order (`*` wildcard). */
  include: z.array(z.string()).default([]),
  /** `source: commands`: left out (`*` wildcard). */
  exclude: z.array(z.string()).default([]),
  /** Item budget including `extraItems`. */
  maxItems: z.number().int().min(1).max(20).default(20),
  /** Command prefix of the generated labels; default the plugin's `commandPrefix`. */
  prefix: z.string().optional(),
  /** `source: commands`: items appended after the generated ones (links …). */
  extraItems: z.array(panelItem).default([]),
  /** `source: manual`: the items. */
  items: z.array(panelItem).default([]),
})

const authorize = z.object({
  enabled: z.boolean().default(true),
  /** Command name, without the slash. */
  command: z.string().default('授权全消息'),
  /** Other names of the command. */
  aliases: z.array(z.string()).default(['qqauth']),
  /** The bot's QQ number (授权页 `botUin`). No default: the plugin carries no bot identity. */
  botUin: z.string().default(''),
  /** The bot's UID (`u_…`, 授权页 `botUid`) — the same bot as `botUin`. */
  botUid: z.string().default(''),
  /** Prefix the “填写群号” / “换个群号” buttons put before the command. */
  inputPrefix: z.string().default('/'),
  /** Send the illustration and guide images with the reply. */
  sendImages: z.boolean().default(true),
})

/** The plugin row's configuration. */
export const Config = z.object({
  /** Limit to one bot id (`qq:<appId>`); empty = every QQ bot. */
  botId: z.string().default(''),
  /** Align the platform with the configuration when a bot comes online (no request when nothing differs). */
  autoSync: z.boolean().default(true),
  /** Delay of the automatic sync after a bot comes online, so the command sources have mounted. */
  autoSyncDelayMs: z.number().int().min(0).max(600000).default(5000),
  /** Re-sync the panels when the skill catalog changes. */
  resyncOnSkillChange: z.boolean().default(true),
  /** Only compute and log the differences. */
  dryRun: z.boolean().default(false),
  /** Delete managed panels (remark prefix) the configuration no longer has. */
  prune: z.boolean().default(false),
  /** Send an empty menu when `menu.items` is empty (clears the platform's menu). */
  allowEmptyMenu: z.boolean().default(false),
  /** Remark prefix of the panels this plugin manages. */
  remarkPrefix: z.string().min(1).default('dsh:'),
  /** Who may run the management commands: platform user ids, or `botId|userId`. */
  admins: z.array(z.string()).default([]),
  /** Prefix of generated panel labels. */
  commandPrefix: z.string().default('/'),
  /** Command sources of generated panels. */
  commands: z.object({
    /** The built-in commands of `dsh-im-session-commands`; set `[]` when that plugin is not mounted. */
    session: z.array(commandEntry).default(SESSION_COMMANDS),
    /** List the `/skill` commands of `dsh-im-dispatch` (`ctx.imDispatch.skills()`), when it is mounted. */
    skills: z.boolean().default(true),
    /** Further commands answered by other plugins. */
    extra: z.array(commandEntry).default([]),
  }).prefault({}),
  /** The custom menu (C2C only); a sync replaces the platform's whole menu. */
  menu: z.object({
    items: z.array(menuItem).max(10).default([]),
  }).prefault({}),
  /** Command panels, at most 20 per bot. */
  panels: z.array(panel).max(20).default([]),
  /** The group owner authorization command. */
  authorize: authorize.prefault({}),
})

/** The resolved configuration. */
export type Config = z.output<typeof Config>
/** One configured panel. */
export type PanelConfig = z.output<typeof panel>
/** One configured command entry. */
export type CommandConfig = z.output<typeof commandEntry>
/** The authorization command's configuration. */
export type AuthorizeConfig = z.output<typeof authorize>
