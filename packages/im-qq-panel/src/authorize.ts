/**
 * The group-owner authorization command (`/授权全消息 <群号>`, alias `qqauth`): lets the official bot receive every
 * message of a group (no @ needed) and speak there on its own.
 *
 * Mobile QQ (9.2.90+) opens the authorization sheet from
 *   https://club.vip.qq.com/transfer?open_kuikly_info=<encodeURIComponent(JSON)>
 *   JSON = { page_name: 'ai_group_service_agreement_pop_page', groupCode, botUin, botUid, screen: 1 }
 *
 * - The bot identity (QQ number + UID) comes from the configuration; the plugin carries none and queries nothing.
 * - The address rides on a `link` button: an official bot's message with a bare link is refused.
 * - An official bot only sees group openids, never the group number, so the user types it; once per group suffices.
 * - Illustration and guide images go first, the button card second (a button turns the whole send into markdown);
 *   when the card fails, a plain-text fallback with the manual path follows.
 *
 * @module dsh-im-qq-panel/authorize
 */

import { existsSync } from 'node:fs'
import { h, type Fragment } from '@deepseek-ai/cordis-plugin-im-core'
import type { AuthorizeConfig } from './config.ts'

export const TRANSFER_ENDPOINT = 'https://club.vip.qq.com/transfer'
export const TRANSFER_PAGE = 'ai_group_service_agreement_pop_page'

/** The packaged images (sources: `guides/*.html`, rendered by `node guides/render.mjs`). */
export const ASSETS = {
  authorize: 'authorize-guide.png',
  manual: 'manual-guide.png',
  groupCode: 'group-code-guide.png',
} as const

export type AssetKey = keyof typeof ASSETS

/** `file:` URLs of the packaged images; the package root is one level above `src/` and `dist/`. */
export function assetUrls(base: URL = new URL('../assets/', import.meta.url)): Partial<Record<AssetKey, string>> {
  const out: Partial<Record<AssetKey, string>> = {}
  for (const [key, file] of Object.entries(ASSETS) as [AssetKey, string][]) {
    const url = new URL(file, base)
    if (existsSync(url)) out[key] = url.href
  }
  return out
}

/** A group number, or why the input is not one. */
export type GroupCodeResult = { ok: true; groupCode: string } | { ok: false; reason: 'missing' } | { ok: false; reason: 'invalid'; input: string }

/**
 * Parse a group number: full-width digits become ASCII, whitespace goes; 5–12 digits without a leading zero.
 * @param input - what the user typed.
 */
export function normalizeGroupCode(input: unknown): GroupCodeResult {
  if (input === undefined || input === null) return { ok: false, reason: 'missing' }
  const text = String(input)
    .replace(/[\uFF10-\uFF19]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, '')
  if (!text) return { ok: false, reason: 'missing' }
  if (!/^[1-9]\d{4,11}$/.test(text)) return { ok: false, reason: 'invalid', input: text }
  return { ok: true, groupCode: text }
}

/** The configured bot identity, or what is wrong with it. */
export type IdentityResult = { ok: true; botUin: string; botUid: string } | { ok: false; message: string }

/**
 * Check the configured bot identity.
 * @param options - `botUin` / `botUid`.
 */
export function validateIdentity(options: { botUin?: string; botUid?: string }): IdentityResult {
  const botUin = String(options.botUin ?? '').trim()
  const botUid = String(options.botUid ?? '').trim()
  if (!/^[1-9]\d{4,11}$/.test(botUin)) {
    const hint = botUin ? `配置无效：${botUin}` : '未配置'
    return { ok: false, message: `authorize.botUin ${hint}（请填写本机器人的 QQ 号，获取方法见 README）` }
  }
  if (!botUid) return { ok: false, message: 'authorize.botUid 未配置（请填写本机器人的 UID，形如 u_xxxxxxxxxxxxxxxxxxxxxx，获取方法见 README）' }
  return { ok: true, botUin, botUid }
}

/**
 * The authorization sheet address (the JSON compact, then encoded as a whole).
 * @param input - group number and bot identity.
 */
export function buildTransferUrl(input: { groupCode: string | number; botUin: string | number; botUid: string }): string {
  const payload = {
    page_name: TRANSFER_PAGE,
    groupCode: Number(input.groupCode),
    botUin: Number(input.botUin),
    botUid: input.botUid,
    screen: 1,
  }
  return `${TRANSFER_ENDPOINT}?open_kuikly_info=${encodeURIComponent(JSON.stringify(payload))}`
}

/** Where the command replies: the platform, and a send that reports whether the platform published it. */
export interface AuthorizeIo {
  platform: string
  /** Publish one message; resolves `false` (or rejects) when the platform did not publish it. */
  send(content: Fragment): Promise<boolean>
}

/** Warnings sink. */
export interface WarnLogger {
  warn(format: string, ...args: unknown[]): void
}

/** The command's runtime: configuration, images (`file:` / `data:` URLs) and a logger. */
export interface AuthorizeDeps {
  options: AuthorizeConfig
  images: Partial<Record<AssetKey, string>>
  logger: WarnLogger
}

async function trySend(io: AuthorizeIo, content: Fragment): Promise<boolean> {
  try {
    return await io.send(content)
  } catch {
    return false
  }
}

function imageElements(deps: AuthorizeDeps, keys: AssetKey[]): Fragment[] {
  if (!deps.options.sendImages) return []
  return keys.filter(key => deps.images[key]).map(key => h('img', { src: deps.images[key]! }))
}

async function sendImages(io: AuthorizeIo, deps: AuthorizeDeps, keys: AssetKey[]): Promise<void> {
  const elements = imageElements(deps, keys)
  if (elements.length) await trySend(io, h('message', {}, ...elements as never[]))
}

async function sendCard(io: AuthorizeIo, deps: AuthorizeDeps, card: Fragment, fallback: string): Promise<void> {
  if (await trySend(io, card)) return
  deps.logger.warn('授权按钮消息发送失败（%s），已改发纯文本', io.platform)
  await io.send(fallback)
}

function commandText(options: AuthorizeConfig): string {
  return `${options.inputPrefix}${options.command} `
}

async function askGroupCode(io: AuthorizeIo, deps: AuthorizeDeps, parsed: Exclude<GroupCodeResult, { ok: true }>): Promise<void> {
  const prefill = commandText(deps.options)
  const lines: string[] = []
  if (parsed.reason === 'invalid') lines.push(`「${parsed.input}」不是有效的群号（5～12 位数字）。`)
  lines.push(`请带上要授权的群号，例如：${prefill}123456789（群里需 @机器人，点下方按钮会自动带上）`)
  lines.push('群号在「群聊设置」页群名下方（见上图），长按可复制。')
  lines.push('授权只能由群主完成，每个群授权一次即可。')
  await sendImages(io, deps, ['groupCode'])
  if (io.platform !== 'qq') {
    await io.send(lines.join('\n'))
    return
  }
  await sendCard(io, deps, h('message', {},
    ...lines.map(line => h('p', {}, line)),
    h('button-group', {}, h('button', { type: 'input', text: prefill, theme: 'info' }, '填写群号')),
  ), lines.join('\n'))
}

async function sendAuthorize(io: AuthorizeIo, deps: AuthorizeDeps, groupCode: string, identity: { botUin: string; botUid: string }): Promise<void> {
  const url = buildTransferUrl({ groupCode, botUin: identity.botUin, botUid: identity.botUid })
  const lines = [
    `群 ${groupCode} 的授权页已生成。`,
    '仅群主可完成授权，需要手机 QQ 9.2.90 及以上。',
    '打开后：消息范围选「获取群内全部消息」，打开「机器人主动在群聊内发言」，再点「同意授权」。',
    '打不开时按第二张图：群成员列表 → 机器人资料页 → 右上角齿轮，手动设置。',
  ]
  await sendImages(io, deps, ['authorize', 'manual'])
  if (io.platform !== 'qq') {
    await io.send([...lines, `授权页：${url}`].join('\n'))
    return
  }
  // An official bot may not put a link into the text, so the fallback only gives the manual path.
  const fallback = [
    `群 ${groupCode}：授权按钮发送失败。`,
    '请群主按上图手动设置：群成员列表 → 机器人资料页 → 右上角齿轮 → 消息范围选「获取群内全部消息」，并打开「机器人主动在群聊内发言」。',
  ].join('\n')
  // One button group: both buttons share a keyboard row.
  await sendCard(io, deps, h('message', {},
    ...lines.map(line => h('p', {}, line)),
    h('button-group', {},
      h('button', { type: 'link', href: url, theme: 'info' }, '群主点此授权'),
      h('button', { type: 'input', text: commandText(deps.options) }, '换个群号'),
    ),
  ), fallback)
}

/**
 * Run the command.
 * @param io - where to reply.
 * @param args - the text after the command name.
 * @param deps - configuration, images, logger.
 * @returns a text to reply when the command could not run (configuration error, send failure), else undefined.
 */
export async function runAuthorize(io: AuthorizeIo, args: string | undefined, deps: AuthorizeDeps): Promise<string | undefined> {
  const identity = validateIdentity(deps.options)
  if (!identity.ok) {
    deps.logger.warn('授权指令配置错误：%s', identity.message)
    return `授权功能配置有误：${identity.message}`
  }
  const parsed = normalizeGroupCode(args)
  try {
    if (!parsed.ok) await askGroupCode(io, deps, parsed)
    else await sendAuthorize(io, deps, parsed.groupCode, identity)
  } catch (error) {
    deps.logger.warn('授权指令执行失败：%s', error instanceof Error ? error.message : String(error))
    return `生成授权按钮失败：${error instanceof Error ? error.message : String(error)}`
  }
  return undefined
}
