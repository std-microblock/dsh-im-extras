/**
 * QQ bot OpenAPI v2: the custom menu (`/v2/menu`) and command panels (`/v2/panels`).
 *
 * Platform documentation: https://bot.q.qq.com/wiki/develop/api-v2/server-inter/menu-panel/
 *
 * Platform rules the validation below enforces before any request:
 * - the custom menu applies to C2C chats only, and `PUT /v2/menu` replaces the whole menu;
 * - panels exist for `c2c` / `group` / `channel` / `dm`; only `c2c` and `group` support `target_type: specific`;
 * - at most 20 panels per bot and 20 items per panel;
 * - name and description lengths count a CJK character as 2.
 *
 * Input accepts both the camelCase of the plugin configuration and the platform's snake_case; output is always the
 * platform shape. Requests go through a {@link QqRequest} transport — in the plugin that is the QQ adapter's own
 * authenticated REST client (`bot.api.request`), so this package never holds a credential.
 *
 * @module dsh-im-qq-panel/api
 */

export const MENU_PATH = '/v2/menu'
export const PANELS_PATH = '/v2/panels'

export const MENU_ITEM_TYPES = ['switch', 'send_message', 'link', 'menu'] as const
export const SUB_MENU_ITEM_TYPES = ['send_message', 'link'] as const
export const PANEL_ITEM_TYPES = ['command', 'link'] as const
export const PANEL_SCOPES = ['c2c', 'group', 'channel', 'dm'] as const
export const PANEL_TARGET_TYPES = ['all', 'specific'] as const
export const PANEL_TARGET_OPS = ['add', 'del'] as const

export type MenuItemType = typeof MENU_ITEM_TYPES[number]
export type SubMenuItemType = typeof SUB_MENU_ITEM_TYPES[number]
export type PanelItemType = typeof PANEL_ITEM_TYPES[number]
export type PanelScope = typeof PANEL_SCOPES[number]
export type PanelTargetType = typeof PANEL_TARGET_TYPES[number]
export type PanelTargetOp = typeof PANEL_TARGET_OPS[number]

/** Platform limits. */
export const LIMITS = {
  menuItems: 10,
  subMenuItems: 5,
  menuItemName: 10,
  subMenuItemName: 14,
  panelItems: 20,
  panelItemName: 14,
  panelItemDesc: 30,
  panelRemark: 255,
  panelsPerApp: 20,
  openIdsPerRequest: 20,
} as const

/** Platform code of a write refused by the rate limit (menu writes 5/min, panel writes 10/min). */
export const RATE_LIMITED = 40023001

/** One sub-menu entry, platform shape. */
export interface SubMenuItem {
  type: SubMenuItemType
  name: string
  send_message?: string
  link?: string
}

/** One menu entry, platform shape. */
export interface MenuItem {
  type: MenuItemType
  name: string
  send_message?: string
  link?: string
  switch?: { switch_id: string; default: boolean }
  sub_menu_items?: SubMenuItem[]
}

/** The menu, platform shape. */
export interface Menu {
  items: MenuItem[]
}

/** One panel item, platform shape. */
export interface PanelItem {
  type: PanelItemType
  name: string
  desc?: string
  link?: string
  only_admin: boolean
}

/** Panel content, platform shape. */
export interface Panel {
  items: PanelItem[]
  remark?: string
  version?: number
}

/** Body of `POST /v2/panels`. */
export interface PanelCreate {
  scope: PanelScope
  target_type: PanelTargetType
  panel: Panel
  user_openids?: string[]
  group_openids?: string[]
}

/** Body of `PUT /v2/panels/{panel_id}/target`. */
export interface PanelTarget {
  op: PanelTargetOp
  user_openids?: string[]
  group_openids?: string[]
}

/** One panel as `GET /v2/panels` lists it. */
export interface PanelRecord {
  panel_id: string
  scope?: string
  target_type?: string
  version?: number
  panel?: { items?: unknown[]; remark?: string }
}

/** One panel as `GET /v2/panels/{id}` answers it (with its target lists). */
export interface PanelDetail extends PanelRecord {
  user_openids?: string[]
  group_openids?: string[]
}

/**
 * The transport: one authenticated request against the QQ API root. The adapter's `QqApi.request` has this shape
 * (`request(method, path, { data })`); a failure rejects with an error carrying `status`, `code` and the decoded `body`.
 */
export type QqRequest = (method: string, path: string, data?: unknown) => Promise<unknown>

type Dict = Record<string, unknown>

/** Wide characters (CJK, full-width forms, Hangul …) count as 2 on the platform. */
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/

/**
 * Length of a text as the platform counts it.
 * @param value - the text.
 * @returns the weight (a CJK character counts 2).
 */
export function textWeight(value: unknown): number {
  let weight = 0
  for (const char of String(value ?? '')) weight += WIDE_CHAR.test(char) ? 2 : 1
  return weight
}

function fail(message: string): never {
  throw new Error(`[qq-panel] ${message}`)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message)
}

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertOneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  assert(typeof value === 'string' && (allowed as readonly string[]).includes(value),
    `${label}只能是 ${allowed.join(' / ')}，收到 ${JSON.stringify(value)}`)
  return value as T
}

function assertText(value: unknown, limit: number, label: string): string {
  assert(typeof value === 'string' && value.trim(), `${label}不能为空`)
  const text = value.trim()
  const weight = textWeight(text)
  assert(weight <= limit, `${label}超长：${weight}/${limit} 个字符（中文按 2 个字符计）`)
  return text
}

function assertHttps(value: unknown, label: string): string {
  assert(typeof value === 'string' && value.trim(), `${label}不能为空`)
  const url = value.trim()
  assert(/^https:\/\//i.test(url), `${label}必须以 https:// 开头，收到 ${url}`)
  return url
}

function assertOptionalText(value: unknown, limit: number, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  if (!text) return undefined
  return assertText(text, limit, label)
}

function assertOpenIdList(value: unknown, label: string): string[] {
  assert(Array.isArray(value) && value.length, `${label}必须是非空数组`)
  assert(value.length <= LIMITS.openIdsPerRequest, `${label}一次最多 ${LIMITS.openIdsPerRequest} 个，收到 ${value.length}`)
  const list = value.map(item => String(item).trim()).filter(Boolean)
  assert(list.length === value.length, `${label}中存在空值`)
  return list
}

function pick(source: unknown, camel: string, snake: string): unknown {
  if (!isDict(source)) return undefined
  const value = source[camel]
  return value === undefined ? source[snake] : value
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function num(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return Number.isFinite(Number(value)) ? Number(value) : undefined
}

// ---------------------------------------------------------------------------------------------------------------
// Custom menu

function normalizeSubMenuItem(input: unknown, label: string): SubMenuItem {
  assert(isDict(input), `${label}必须是对象`)
  const type = assertOneOf(input.type, SUB_MENU_ITEM_TYPES, `${label} type`)
  const item: SubMenuItem = { type, name: assertText(input.name, LIMITS.subMenuItemName, `${label}名称`) }
  if (type === 'send_message') {
    const text = pick(input, 'sendMessage', 'send_message')
    assert(typeof text === 'string' && text.trim(), `${label}缺少 sendMessage`)
    item.send_message = text.trim()
  } else {
    item.link = assertHttps(input.link, `${label} link`)
  }
  return item
}

function normalizeMenuItem(input: unknown, index: number): MenuItem {
  const label = `菜单项 #${index + 1}`
  assert(isDict(input), `${label}必须是对象`)
  const type = assertOneOf(input.type, MENU_ITEM_TYPES, `${label}的 type`)
  const item: MenuItem = { type, name: assertText(input.name, LIMITS.menuItemName, `${label}名称`) }
  if (type === 'send_message') {
    const text = pick(input, 'sendMessage', 'send_message')
    assert(typeof text === 'string' && text.trim(), `${label}（send_message）缺少 sendMessage`)
    item.send_message = text.trim()
  } else if (type === 'link') {
    item.link = assertHttps(input.link, `${label}的 link`)
  } else if (type === 'switch') {
    const nested = isDict(input.switch) ? input.switch : undefined
    const switchId = str(input.switchId) ?? str(nested?.switch_id)
    assert(switchId, `${label}（switch）缺少 switchId`)
    item.switch = { switch_id: switchId, default: Boolean(input.switchDefault ?? nested?.default) }
  } else {
    const subs = pick(input, 'subMenuItems', 'sub_menu_items') ?? []
    assert(Array.isArray(subs), `${label}的 subMenuItems 必须是数组`)
    assert(subs.length && subs.length <= LIMITS.subMenuItems, `${label}子菜单数量必须是 1-${LIMITS.subMenuItems}，收到 ${subs.length}`)
    item.sub_menu_items = subs.map((sub, index2) => normalizeSubMenuItem(sub, `${label}子菜单 #${index2 + 1}`))
  }
  return item
}

/**
 * Validate and normalize a menu configuration.
 * @param input - `{ items }` or the bare item array.
 * @returns the platform shape.
 */
export function normalizeMenu(input: unknown): Menu {
  const items = Array.isArray(input) ? input : (pick(input, 'items', 'items') ?? [])
  assert(Array.isArray(items), '菜单 items 必须是数组')
  assert(items.length <= LIMITS.menuItems, `菜单项最多 ${LIMITS.menuItems} 个，收到 ${items.length}`)
  return { items: items.map((item, index) => normalizeMenuItem(item, index)) }
}

// ---------------------------------------------------------------------------------------------------------------
// Command panels

function normalizePanelItem(input: unknown, index: number): PanelItem {
  const label = `面板元素 #${index + 1}`
  assert(isDict(input), `${label}必须是对象`)
  const type = assertOneOf(input.type, PANEL_ITEM_TYPES, `${label}的 type`)
  const name = assertText(input.name, LIMITS.panelItemName, `${label}名称`)
  const desc = assertOptionalText(input.desc, LIMITS.panelItemDesc, `${label}描述`)
  const item: PanelItem = { type, name, only_admin: false }
  if (desc) item.desc = desc
  if (type === 'link') item.link = assertHttps(input.link, `${label}的 link`)
  item.only_admin = Boolean(pick(input, 'onlyAdmin', 'only_admin'))
  return item
}

/**
 * Validate and normalize panel content.
 * @param input - `{ items, remark?, version? }`.
 * @returns the platform shape.
 */
export function normalizePanel(input: unknown): Panel {
  assert(isDict(input), '面板内容必须是对象')
  const items = input.items ?? []
  assert(Array.isArray(items), '面板 items 必须是数组')
  assert(items.length <= LIMITS.panelItems, `面板元素最多 ${LIMITS.panelItems} 个，收到 ${items.length}`)
  const panel: Panel = { items: items.map((item, index) => normalizePanelItem(item, index)) }
  const remark = assertOptionalText(input.remark, LIMITS.panelRemark, '面板备注')
  if (remark) panel.remark = remark
  const version = num(input.version)
  if (version !== undefined) panel.version = version
  return panel
}

/**
 * Build the body of `POST /v2/panels`.
 * @param input - `{ scope, targetType?, userOpenIds?, groupOpenIds?, panel }` (or snake_case).
 * @returns the validated body.
 */
export function buildPanelCreate(input: unknown): PanelCreate {
  assert(isDict(input), '创建面板需要配置对象')
  const scope = assertOneOf(input.scope, PANEL_SCOPES, '面板 scope')
  const targetType = assertOneOf(pick(input, 'targetType', 'target_type') ?? 'all', PANEL_TARGET_TYPES, '面板 targetType')
  if (targetType === 'specific') {
    assert(scope === 'c2c' || scope === 'group', `targetType=specific 只支持 c2c/group 场景，收到 ${scope}`)
  }
  const payload: PanelCreate = { scope, target_type: targetType, panel: normalizePanel(input.panel ?? input) }
  if (targetType === 'specific') {
    if (scope === 'group') payload.group_openids = assertOpenIdList(pick(input, 'groupOpenIds', 'group_openids'), 'groupOpenIds')
    else payload.user_openids = assertOpenIdList(pick(input, 'userOpenIds', 'user_openids'), 'userOpenIds')
  }
  return payload
}

/**
 * Build the body of `PUT /v2/panels/{panel_id}/target`.
 * @param input - `{ op, userOpenIds?, groupOpenIds? }` (or snake_case).
 * @returns the validated body.
 */
export function buildPanelTarget(input: unknown): PanelTarget {
  assert(isDict(input), '修改面板关联对象需要配置对象')
  const op = assertOneOf(input.op, PANEL_TARGET_OPS, '关联对象操作 op')
  const payload: PanelTarget = { op }
  const userOpenIds = pick(input, 'userOpenIds', 'user_openids')
  const groupOpenIds = pick(input, 'groupOpenIds', 'group_openids')
  if (userOpenIds) payload.user_openids = assertOpenIdList(userOpenIds, 'userOpenIds')
  if (groupOpenIds) payload.group_openids = assertOpenIdList(groupOpenIds, 'groupOpenIds')
  assert(payload.user_openids || payload.group_openids, '关联对象操作必须提供 userOpenIds 或 groupOpenIds')
  return payload
}

// ---------------------------------------------------------------------------------------------------------------
// Canonical forms for comparison: the local desired value and the platform's answer reduced to the same shape,
// keeping only the fields the platform acknowledges, so an absent field or an empty value is no difference.

function canonicalSubMenuItem(input: unknown): unknown {
  if (!isDict(input)) return undefined
  const out: Dict = { type: input.type, name: str(input.name) }
  if (input.type === 'send_message') out.send_message = str(input.send_message)
  else if (input.type === 'link') out.link = str(input.link)
  return out
}

/**
 * Canonical form of one menu item.
 * @param input - platform-shaped item.
 * @returns the comparable value.
 */
export function canonicalMenuItem(input: unknown): unknown {
  if (!isDict(input)) return undefined
  const out: Dict = { type: input.type, name: str(input.name) }
  if (input.type === 'send_message') out.send_message = str(input.send_message)
  else if (input.type === 'link') out.link = str(input.link)
  else if (input.type === 'switch') {
    const nested = isDict(input.switch) ? input.switch : {}
    out.switch = { switch_id: str(nested.switch_id), default: Boolean(nested.default) }
  } else if (input.type === 'menu') {
    out.sub_menu_items = (Array.isArray(input.sub_menu_items) ? input.sub_menu_items : []).map(canonicalSubMenuItem)
  }
  return out
}

/**
 * Canonical form of one panel item.
 * @param input - platform-shaped item.
 * @returns the comparable value.
 */
export function canonicalPanelItem(input: unknown): unknown {
  if (!isDict(input)) return undefined
  const out: Dict = { type: input.type, name: str(input.name) }
  const desc = str(input.desc)
  if (desc) out.desc = desc
  if (input.type === 'link') out.link = str(input.link)
  out.only_admin = Boolean(input.only_admin)
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Errors

/** The decoded answer body of a failed request, when the error carries one. */
function bodyOf(error: unknown): Dict | undefined {
  if (!isDict(error) && !(error instanceof Error)) return undefined
  const record = error as unknown as Dict
  if (isDict(record.body)) return record.body
  const response = record.response
  if (isDict(response) && isDict(response.data)) return response.data
  return undefined
}

/**
 * The platform's business code of a failure (`err_code`, else `code`).
 * @param error - the thrown value.
 * @returns the code, when there is one.
 */
export function errorCode(error: unknown): number | undefined {
  const body = bodyOf(error)
  const code = num(body?.err_code) ?? num(body?.code) ?? (isDict(error) || error instanceof Error ? num((error as unknown as Dict).code) : undefined)
  return code
}

/**
 * Whether a failure is the platform's write rate limit (`err_code 40023001`, or HTTP 429).
 * @param error - the thrown value.
 * @returns true when the remaining writes should wait.
 */
export function isRateLimited(error: unknown): boolean {
  if (errorCode(error) === RATE_LIMITED) return true
  return (error instanceof Error || isDict(error)) && (error as unknown as Dict).status === 429
}

/**
 * One line describing a failure: the platform message, its code and trace id.
 * @param error - the thrown value.
 * @returns the description.
 */
export function describeError(error: unknown): string {
  const body = bodyOf(error)
  const code = errorCode(error)
  const message = str(body?.message) ?? (error instanceof Error ? error.message : String(error))
  const trace = str(body?.trace_id) ? `，trace_id ${String(body?.trace_id)}` : ''
  if (code) return `${message}（err_code ${code}）${trace}`
  return `${message}${trace}`
}

// ---------------------------------------------------------------------------------------------------------------
// Requests

function panelPath(panelId: unknown): string {
  assert(typeof panelId === 'string' && panelId.trim(), 'panel_id 不能为空')
  return `${PANELS_PATH}/${encodeURIComponent(panelId.trim())}`
}

function asDict(value: unknown): Dict {
  return isDict(value) ? value : {}
}

/** `GET /v2/menu`. */
export async function getMenu(request: QqRequest): Promise<{ version: number; menu: { items?: unknown[] } }> {
  const data = asDict(await request('GET', MENU_PATH))
  return { version: num(data.version) ?? 0, menu: asDict(data.menu) as { items?: unknown[] } }
}

/** `PUT /v2/menu` with a validated menu; replaces the whole menu. */
export async function updateMenu(request: QqRequest, menu: unknown): Promise<{ version: number }> {
  const data = asDict(await request('PUT', MENU_PATH, { menu: normalizeMenu(menu) }))
  return { version: num(data.version) ?? 0 }
}

/** `GET /v2/panels`: one page of one scope. */
export async function getPanels(
  request: QqRequest,
  params: { scope: string; cursor?: string; limit?: number },
): Promise<{ records: PanelRecord[]; nextCursor: string; isEnd: boolean }> {
  const scope = assertOneOf(params.scope, PANEL_SCOPES, '查询面板的 scope')
  const query = new URLSearchParams({ scope })
  if (params.cursor) query.set('cursor', params.cursor)
  if (params.limit) query.set('limit', String(params.limit))
  const raw = await request('GET', `${PANELS_PATH}?${query.toString()}`)
  const data = asDict(raw)
  return {
    records: Array.isArray(data.records) ? data.records as PanelRecord[] : [],
    nextCursor: typeof data.next_cursor === 'string' ? data.next_cursor : '',
    isEnd: raw === undefined || data.is_end === true,
  }
}

/** Every panel of one scope, page by page, guarding against a repeated cursor. */
export async function getAllPanels(request: QqRequest, scope: string, limit = 50): Promise<PanelRecord[]> {
  const records: PanelRecord[] = []
  const seen = new Set<string>()
  const cursors = new Set<string>()
  let cursor = ''
  for (let page = 0; page < 20; page += 1) {
    const result = await getPanels(request, { scope, cursor, limit })
    for (const record of result.records) {
      if (!record?.panel_id || seen.has(record.panel_id)) continue
      seen.add(record.panel_id)
      records.push(record)
    }
    if (result.isEnd || !result.nextCursor) break
    if (cursors.has(result.nextCursor)) break
    cursors.add(result.nextCursor)
    cursor = result.nextCursor
  }
  return records
}

/** `POST /v2/panels`. `payload` is either a built body (has `panel`) or a configuration `buildPanelCreate` accepts. */
export async function createPanel(request: QqRequest, payload: unknown): Promise<{ panelId: string; scope: string }> {
  const body = isDict(payload) && isDict(payload.panel) && typeof payload.target_type === 'string'
    ? payload as unknown as PanelCreate
    : buildPanelCreate(payload)
  const data = asDict(await request('POST', PANELS_PATH, body))
  return { panelId: String(data.panel_id ?? ''), scope: body.scope }
}

/** `GET /v2/panels/{id}`. */
export async function getPanel(request: QqRequest, panelId: string): Promise<PanelDetail> {
  return asDict(await request('GET', panelPath(panelId))) as unknown as PanelDetail
}

/** `PUT /v2/panels/{id}` with validated content. */
export async function updatePanel(request: QqRequest, panelId: string, panel: unknown): Promise<{ version: number }> {
  const data = asDict(await request('PUT', panelPath(panelId), { panel: normalizePanel(panel) }))
  return { version: num(data.version) ?? 0 }
}

/** `DELETE /v2/panels/{id}`. */
export async function deletePanel(request: QqRequest, panelId: string): Promise<true> {
  await request('DELETE', panelPath(panelId))
  return true
}

/** `PUT /v2/panels/{id}/target`. */
export async function updatePanelTarget(request: QqRequest, panelId: string, payload: unknown): Promise<true> {
  await request('PUT', `${panelPath(panelId)}/target`, buildPanelTarget(payload))
  return true
}
