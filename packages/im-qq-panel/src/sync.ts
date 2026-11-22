/**
 * Difference planning between the configured menu / panels and the platform (pure functions).
 *
 * The configuration is the desired state. The platform is read first and a write is planned only where the content
 * differs, so a restart does not bump the platform's versions or spend the write budget (menu 5/min, panels 10/min).
 *
 * @module dsh-im-qq-panel/sync
 */

import {
  buildPanelCreate, canonicalMenuItem, canonicalPanelItem,
  type Menu, type Panel, type PanelDetail, type PanelRecord, type PanelScope, type PanelTargetType,
} from './api.ts'

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key]
      if (item === undefined) continue
      out[key] = sortValue(item)
    }
    return out
  }
  return value
}

/** JSON with sorted keys and without `undefined` members. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

/** Structural equality through {@link stableStringify}. */
export function sameJson(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b)
}

/** What the menu sync would do. */
export interface MenuPlan {
  changed: boolean
  remoteVersion: number
  remoteItemCount: number
  desiredItemCount: number
}

/**
 * Compare the platform menu with the desired one.
 * @param remote - `getMenu` answer.
 * @param desired - normalized menu.
 * @returns whether a write is needed.
 */
export function planMenu(remote: { version?: number; menu?: { items?: unknown[] } } | undefined, desired: Menu): MenuPlan {
  const remoteItems = (remote?.menu?.items ?? []).map(canonicalMenuItem)
  const desiredItems = (desired.items ?? []).map(canonicalMenuItem)
  return {
    changed: !sameJson(remoteItems, desiredItems),
    remoteVersion: remote?.version ?? 0,
    remoteItemCount: remoteItems.length,
    desiredItemCount: desiredItems.length,
  }
}

/** The panel configuration fields the planner reads. */
export interface PanelConfigInput {
  key?: string
  scope?: string
  targetType?: string
  userOpenIds?: string[]
  groupOpenIds?: string[]
  panelId?: string
  remark?: string
  items?: unknown[]
}

/** A configured panel, validated and in platform shape, with its local key and remark. */
export interface DesiredPanel {
  key: string
  remark: string
  scope: PanelScope
  targetType: PanelTargetType
  userOpenIds: string[]
  groupOpenIds: string[]
  panelId: string
  panel: Panel
  /** Where the items came from: generated from command sources, or listed in the configuration. */
  source?: 'commands' | 'manual'
}

/**
 * Validate one configured panel into its platform shape. `buildPanelCreate` does the validation (scope,
 * target type, item count, links, lengths), so configuration checks and request bodies share one implementation.
 * @param input - the configured panel.
 * @param index - its position, for messages.
 * @param options - remark prefix, and items resolved by the caller (generated ones replace `input.items`).
 * @returns the desired panel.
 */
export function normalizePanelConfig(
  input: PanelConfigInput,
  index: number,
  options: { remarkPrefix?: string; items?: unknown[] } = {},
): DesiredPanel {
  const prefix = options.remarkPrefix || 'dsh:'
  const label = `面板 #${index + 1}`
  if (!input || typeof input !== 'object') throw new Error(`${label} 必须是对象`)
  const key = typeof input.key === 'string' ? input.key.trim() : ''
  if (!key) throw new Error(`${label} 缺少 key（本地标识，用于生成面板备注并匹配远端面板）`)
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(key)) throw new Error(`${label} 的 key 只能包含字母、数字、. _ -，且不超过 64 个字符`)
  const remark = typeof input.remark === 'string' && input.remark.trim() ? input.remark.trim() : `${prefix}${key}`
  const items = options.items === undefined ? input.items : options.items
  const payload = buildPanelCreate({
    scope: input.scope,
    targetType: input.targetType,
    userOpenIds: input.userOpenIds,
    groupOpenIds: input.groupOpenIds,
    panel: { items, remark },
  })
  return {
    key,
    remark: payload.panel.remark ?? remark,
    scope: payload.scope,
    targetType: payload.target_type,
    userOpenIds: payload.user_openids ?? [],
    groupOpenIds: payload.group_openids ?? [],
    panelId: typeof input.panelId === 'string' ? input.panelId.trim() : '',
    panel: payload.panel,
  }
}

/** Index remote panels by id and by remark (the remark carries the local key). */
export function indexPanels(records: readonly PanelRecord[]): { byId: Map<string, PanelRecord>; byRemark: Map<string, PanelRecord> } {
  const byId = new Map<string, PanelRecord>()
  const byRemark = new Map<string, PanelRecord>()
  for (const record of records ?? []) {
    if (!record?.panel_id) continue
    byId.set(record.panel_id, record)
    const remark = record.panel?.remark
    if (remark && !byRemark.has(remark)) byRemark.set(remark, record)
  }
  return { byId, byRemark }
}

/** A desired panel with the remote record it maps to, if any. */
export interface PanelMatch {
  panel: DesiredPanel
  record: PanelRecord | undefined
}

/** Pair desired panels with remote records: by `panelId` when bound, by remark otherwise. */
export function matchPanels(desired: readonly DesiredPanel[], records: readonly PanelRecord[]): PanelMatch[] {
  const index = indexPanels(records)
  return (desired ?? []).map(panel => ({
    panel,
    record: panel.panelId ? index.byId.get(panel.panelId) : index.byRemark.get(panel.remark),
  }))
}

/** The openids to add to and remove from a specific panel. */
export function diffOpenIds(desired: readonly string[] | undefined, remote: readonly string[] | undefined): { add: string[]; del: string[] } {
  const want = new Set((desired ?? []).map(String).filter(Boolean))
  const have = new Set((remote ?? []).map(String).filter(Boolean))
  return {
    add: [...want].filter(id => !have.has(id)),
    del: [...have].filter(id => !want.has(id)),
  }
}

/** Whether two item lists are the same after canonicalization. */
export function samePanelItems(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  return sameJson((a ?? []).map(canonicalPanelItem), (b ?? []).map(canonicalPanelItem))
}

/** One planned panel action. */
export type PanelAction =
  | { type: 'create'; panel: DesiredPanel; note?: string }
  | { type: 'recreate'; panel: DesiredPanel; panelId: string; reason: string }
  | { type: 'update'; panel: DesiredPanel; panelId: string; itemsChanged: boolean; remarkChanged: boolean }
  | { type: 'unchanged'; panel: DesiredPanel; panelId: string }
  | { type: 'target'; panel: DesiredPanel; panelId: string; op: 'add' | 'del'; scope: PanelScope; openIds: string[] }
  | { type: 'warn'; panel: DesiredPanel; message: string }
  | { type: 'delete'; panelId: string; remark: string }

/** Input of {@link planPanels}. */
export interface PlanPanelsInput {
  matches: readonly PanelMatch[]
  /** `panel_id` → detail; needed for specific panels only (the list has no target ids). */
  details?: ReadonlyMap<string, PanelDetail>
  /** Every remote record read this time. */
  records?: readonly PanelRecord[]
  /** Remark prefix of the panels this plugin manages. */
  remarkPrefix?: string
  /** Delete managed panels the configuration no longer has. */
  prune?: boolean
}

/**
 * Plan the panel actions.
 *
 * The platform cannot change a panel's scope or target type, so a mismatch there is planned as delete + create of
 * the same panel (`recreate`). Openid lists of a specific panel are reconciled with `target` add / del.
 * @param options - matches, details, records, prefix and prune.
 * @returns the actions in order.
 */
export function planPanels(options: PlanPanelsInput): PanelAction[] {
  const matches = options.matches ?? []
  const details = options.details
  const records = options.records ?? []
  const prefix = options.remarkPrefix || 'dsh:'
  const actions: PanelAction[] = []
  const claimed = new Set<string>()

  for (const { panel, record } of matches) {
    if (!record) {
      actions.push({
        type: 'create',
        panel,
        ...panel.panelId ? { note: `绑定的 panel_id ${panel.panelId} 在 ${panel.scope} 场景中不存在，将重新创建` } : {},
      })
      continue
    }
    claimed.add(record.panel_id)

    if (record.scope && panel.scope && record.scope !== panel.scope) {
      actions.push({ type: 'recreate', panel, panelId: record.panel_id, reason: `生效场景需要从 ${record.scope} 改为 ${panel.scope}` })
      continue
    }
    if (record.target_type && record.target_type !== panel.targetType) {
      actions.push({ type: 'recreate', panel, panelId: record.panel_id, reason: `作用范围需要从 ${record.target_type} 改为 ${panel.targetType}` })
      continue
    }

    const remote = record.panel ?? {}
    const itemsChanged = !samePanelItems(panel.panel.items, remote.items)
    const remarkChanged = (remote.remark ?? '') !== (panel.panel.remark ?? '')
    if (itemsChanged || remarkChanged) {
      actions.push({ type: 'update', panel, panelId: record.panel_id, itemsChanged, remarkChanged })
    } else {
      actions.push({ type: 'unchanged', panel, panelId: record.panel_id })
    }

    if (panel.targetType === 'specific') {
      const detail = details?.get(record.panel_id)
      if (!detail) {
        actions.push({ type: 'warn', panel, message: `未取得面板 ${record.panel_id} 的详情，跳过关联对象校验` })
      } else {
        const remoteIds = panel.scope === 'group' ? detail.group_openids : detail.user_openids
        const desiredIds = panel.scope === 'group' ? panel.groupOpenIds : panel.userOpenIds
        const { add, del } = diffOpenIds(desiredIds, remoteIds)
        if (add.length) actions.push({ type: 'target', panel, panelId: record.panel_id, op: 'add', scope: panel.scope, openIds: add })
        if (del.length) actions.push({ type: 'target', panel, panelId: record.panel_id, op: 'del', scope: panel.scope, openIds: del })
      }
    }
  }

  if (options.prune) {
    for (const record of records) {
      const remark = record?.panel?.remark
      if (!remark || !String(remark).startsWith(prefix)) continue
      if (claimed.has(record.panel_id)) continue
      actions.push({ type: 'delete', panelId: record.panel_id, remark })
    }
  }

  return actions
}
