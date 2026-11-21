/**
 * `AuthRequest`: prebuilt card component for claiming session exclusivity and requesting capability grants.
 *
 * Unlike `PromptButton` (which sends text through `agent.send`), `<AuthRequest>` invokes trusted host actions
 * (`auth:describe`, `auth:grant`, `auth:decline`, `auth:revoke`) and subscribes to host-pushed `'auth'` events
 * (such as DM OAuth completion or credential revocation). The platform-verified clicker identity lives on the host
 * side and cannot be forged by card code or prompt injection.
 *
 * @module dsh-im-card/vm/presets/auth
 */
import { callHostAction, cardHandle, onHostEvent } from '../actions.ts'
import { useEffect, useState } from '../hooks.ts'
import { h, type VNode } from '../jsx.ts'
import { personOf, targetOf, type AnsweredBy, type PromptTarget, type PromptTargetProps } from './shared.tsx'

/** One capability entry accepted by `<AuthRequest capabilities={[...]} />`. */
export interface AuthCapabilityOption {
  /** Registered capability id, e.g. `'feishu-project'`. */
  id: string
  /** Optional display label overriding the provider's default title. */
  label?: string
  /** Optional short description shown under the capability name. */
  description?: string
  /** Whether the checkbox starts checked when multiple capabilities are listed (default `true`). */
  defaultChecked?: boolean
}

/** Props of `<AuthRequest>`. */
export interface AuthRequestProps extends PromptTargetProps {
  /** Capabilities to request; omit or pass `[]` to claim pure session exclusivity without extra capabilities. */
  capabilities?: (string | AuthCapabilityOption)[]
  /** Why authorization / exclusivity is needed. */
  reason?: string
  /** Optional heading shown above the request. */
  title?: string
  /** Optional confirmation dialog shown before granting. */
  confirm?: { title: string; text: string }
  /** Optional replacement content once granted (applied when there are no active revocable capabilities). */
  done?: unknown
}

interface NormalizedOption {
  id: string
  label?: string
  description?: string
  defaultChecked: boolean
}

interface CapabilityMeta {
  title: string
  description?: string
}

export interface AuthCapabilityStatusItem {
  id: string
  title: string
  status: 'active' | 'pending' | 'reauth_required' | 'revoked' | 'failed'
  message?: string
}

export interface AuthCardState {
  status: 'idle' | 'pending' | 'granted' | 'declined' | 'revoked' | 'error'
  owner?: { id: string; name?: string }
  actor?: { id: string; name?: string }
  items: AuthCapabilityStatusItem[]
  message?: string
}

function normalizeOptions(raw: AuthRequestProps['capabilities']): NormalizedOption[] {
  if (!Array.isArray(raw)) return []
  const out: NormalizedOption[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const id = entry.trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push({ id, defaultChecked: true })
    } else if (entry !== null && typeof entry === 'object' && typeof entry.id === 'string') {
      const id = entry.id.trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push({
        id,
        ...(entry.label !== undefined && String(entry.label).trim() !== '' ? { label: String(entry.label).trim() } : {}),
        ...(entry.description !== undefined && String(entry.description).trim() !== ''
          ? { description: String(entry.description).trim() }
          : {}),
        defaultChecked: entry.defaultChecked !== false,
      })
    }
  }
  return out
}

function clickUserOf(event: unknown): { id: string; name?: string } {
  const user =
    event !== null && typeof event === 'object' ? (event as { user?: { id?: unknown; name?: unknown } }).user : undefined
  const id = typeof user?.id === 'string' ? user.id : ''
  const name = typeof user?.name === 'string' && user.name !== '' ? user.name : undefined
  return name === undefined ? { id } : { id, name }
}

function answeredByOf(who: { id: string; name?: string } | undefined): AnsweredBy | undefined {
  if (who === undefined || who.id === '') return undefined
  return { id: who.id, name: who.name ?? '' }
}

function parseState(raw: unknown): AuthCardState | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const status = obj.status
  if (
    status !== 'idle' &&
    status !== 'pending' &&
    status !== 'granted' &&
    status !== 'declined' &&
    status !== 'revoked' &&
    status !== 'error'
  ) {
    return null
  }
  const toUser = (v: unknown): { id: string; name?: string } | undefined => {
    if (v === null || typeof v !== 'object') return undefined
    const u = v as Record<string, unknown>
    if (typeof u.id !== 'string' || u.id === '') return undefined
    return typeof u.name === 'string' && u.name !== '' ? { id: u.id, name: u.name } : { id: u.id }
  }
  const items: AuthCapabilityStatusItem[] = []
  if (Array.isArray(obj.items)) {
    for (const item of obj.items) {
      if (item === null || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      if (typeof row.id !== 'string' || typeof row.title !== 'string' || typeof row.status !== 'string') continue
      if (
        row.status !== 'active' &&
        row.status !== 'pending' &&
        row.status !== 'reauth_required' &&
        row.status !== 'revoked' &&
        row.status !== 'failed'
      ) {
        continue
      }
      items.push({
        id: row.id,
        title: row.title,
        status: row.status,
        ...(typeof row.message === 'string' && row.message !== '' ? { message: row.message } : {}),
      })
    }
  }
  return {
    status,
    ...(toUser(obj.owner) === undefined ? {} : { owner: toUser(obj.owner) }),
    ...(toUser(obj.actor) === undefined ? {} : { actor: toUser(obj.actor) }),
    items,
    ...(typeof obj.message === 'string' && obj.message !== '' ? { message: obj.message } : {}),
  }
}

function statusIcon(status: AuthCapabilityStatusItem['status']): string {
  switch (status) {
    case 'active':
      return '✅'
    case 'pending':
      return '⏳'
    case 'reauth_required':
      return '⚠️'
    case 'revoked':
      return '🔒'
    case 'failed':
      return '❌'
  }
}

function authTargetOf(props: AuthRequestProps): PromptTarget {
  return targetOf({ ...props, sender: props.sender ?? 'anyone' })
}

function renderPersonSuffix(who: { id: string; name?: string } | undefined): unknown[] {
  const inline = personOf(answeredByOf(who))
  return inline === null ? [] : [' · ', inline]
}

/**
 * Interactive authorization and session-exclusivity request component.
 * @param props - requested capabilities, reason, and target user constraints.
 */
export function AuthRequest(props: AuthRequestProps): VNode[] {
  const p = props === null || props === undefined ? ({} as AuthRequestProps) : props
  const options = normalizeOptions(p.capabilities)
  const optionIds = options.map((opt) => opt.id)

  const [meta] = useState<Record<string, CapabilityMeta>>(() => {
    const out: Record<string, CapabilityMeta> = {}
    for (const opt of options) {
      out[opt.id] = {
        title: opt.label ?? opt.id,
        ...(opt.description === undefined ? {} : { description: opt.description }),
      }
    }
    if (options.length > 0) {
      const reply = callHostAction('auth:describe', { capabilities: optionIds })
      if (reply.ok === true && Array.isArray(reply.capabilities)) {
        for (const entry of reply.capabilities as Array<Record<string, unknown>>) {
          const id = typeof entry.id === 'string' ? entry.id : ''
          if (!id) continue
          const prev = out[id]
          const title = typeof entry.title === 'string' && entry.title !== '' ? entry.title : prev?.title ?? id
          const description =
            typeof entry.description === 'string' && entry.description !== '' ? entry.description : prev?.description
          out[id] = {
            title: prev !== undefined && prev.title !== id ? prev.title : title,
            ...(description === undefined ? {} : { description }),
          }
        }
      }
    }
    return out
  })

  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {}
    for (const opt of options) initial[opt.id] = opt.defaultChecked
    return initial
  })

  const [view, setView] = useState<AuthCardState>(() => ({ status: 'idle', items: [] }))

  useEffect(() => {
    return onHostEvent('auth', (payload) => {
      const next = parseState(payload)
      if (next === null) return
      const obj = payload as Record<string, unknown>
      const matches =
        obj.all === true ||
        (optionIds.length === 0 && next.items.length === 0) ||
        next.items.some((item) => optionIds.indexOf(item.id) >= 0)
      if (!matches) return
      setView(next)
    })
  }, [])

  const checkAllowed = (event: unknown): { id: string; name?: string } | null => {
    const target = authTargetOf(p)
    const user = clickUserOf(event)
    if (target.id !== '' && user.id !== target.id) {
      cardHandle.toast('只有 ' + (target.name || '指定成员') + ' 可以操作', 'warning')
      return null
    }
    return user
  }

  const runGrant = (event: unknown, requestedIds: string[]) => {
    if (checkAllowed(event) === null) return
    const reply = callHostAction('auth:grant', {
      capabilities: requestedIds,
      ...(p.sender === undefined ? {} : { sender: String(p.sender) }),
      ...(p.senderName === undefined ? {} : { senderName: String(p.senderName) }),
      ...(p.reason === undefined ? {} : { reason: String(p.reason) }),
    })
    if (reply.ok !== true) {
      cardHandle.toast(typeof reply.error === 'string' ? reply.error : '授权请求失败', 'warning')
      return
    }
    const next = parseState(reply.state)
    if (next !== null) setView(next)
    if (typeof reply.toast === 'string' && reply.toast !== '') {
      cardHandle.toast(reply.toast, next?.status === 'error' ? 'error' : 'success')
    }
  }

  const runDecline = (event: unknown) => {
    if (checkAllowed(event) === null) return
    const reply = callHostAction('auth:decline', {
      capabilities: optionIds,
      ...(p.sender === undefined ? {} : { sender: String(p.sender) }),
      ...(p.senderName === undefined ? {} : { senderName: String(p.senderName) }),
    })
    if (reply.ok !== true) {
      cardHandle.toast(typeof reply.error === 'string' ? reply.error : '操作失败', 'warning')
      return
    }
    const next = parseState(reply.state)
    if (next !== null) setView(next)
    cardHandle.toast(typeof reply.toast === 'string' && reply.toast !== '' ? reply.toast : '已拒绝授权', 'info')
  }

  const runRevoke = (event: unknown) => {
    const user = clickUserOf(event)
    const target = authTargetOf(p)
    const isOwnerOrActor =
      (view.owner !== undefined && user.id === view.owner.id) ||
      (view.actor !== undefined && user.id === view.actor.id)
    if (!isOwnerOrActor && (target.id === '' || user.id !== target.id)) {
      cardHandle.toast('只有授权人或独占者可以撤销授权', 'warning')
      return
    }
    const revocableIds = view.items
      .filter((item) => item.status === 'active' || item.status === 'reauth_required')
      .map((item) => item.id)
    const reply = callHostAction('auth:revoke', {
      capabilities: revocableIds.length > 0 ? revocableIds : optionIds,
    })
    if (reply.ok !== true) {
      cardHandle.toast(typeof reply.error === 'string' ? reply.error : '撤销失败', 'warning')
      return
    }
    const next = parseState(reply.state)
    if (next !== null) setView(next)
    cardHandle.toast(typeof reply.toast === 'string' && reply.toast !== '' ? reply.toast : '已撤销授权', 'info')
  }

  const titleText =
    p.title !== undefined && String(p.title).trim() !== ''
      ? String(p.title).trim()
      : options.length === 0
        ? '🔐 请求会话独占'
        : '🔐 请求会话独占与能力授权'

  if (view.status === 'granted') {
    const revocable = view.items.some((item) => item.status === 'active' || item.status === 'reauth_required')
    if (!revocable && p.done !== undefined) return [p.done as VNode]
    const who = view.actor ?? view.owner
    const label = view.items.length === 0 ? '✅ 已认领并独占会话' : '✅ 已授权并独占会话'
    const blocks: VNode[] = [<p>{label}{...renderPersonSuffix(who)}</p>]
    for (const item of view.items) {
      const detail = item.message ? `：${item.message}` : ''
      blocks.push(<small key={item.id}>{`${statusIcon(item.status)} ${item.title}${detail}`}</small>)
    }
    if (revocable) {
      blocks.push(
        <button
          size="small"
          variant="danger_text"
          confirm={{ title: '撤销授权', text: '撤销后该会话将不再继续使用已授权能力，但会话仍保持独占。确定撤销吗？' }}
          onClick={runRevoke}
        >
          撤销授权
        </button>,
      )
    }
    return blocks
  }

  if (view.status === 'pending') {
    const who = view.actor ?? view.owner
    const person = personOf(answeredByOf(who))
    const pendingIds = view.items.filter((item) => item.status === 'pending').map((item) => item.id)
    const blocks: VNode[] = [
      <p>
        {person === null ? '⏳ 等待在私聊中完成登录…' : ['⏳ 等待 ', person, ' 在私聊中完成登录…']}
      </p>,
    ]
    for (const item of view.items) {
      const detail = item.message ? `：${item.message}` : ''
      blocks.push(<small key={item.id}>{`${statusIcon(item.status)} ${item.title}${detail}`}</small>)
    }
    blocks.push(
      <button-group>
        <button size="small" onClick={(e: unknown) => runGrant(e, pendingIds.length > 0 ? pendingIds : optionIds)}>
          重新发送登录通知
        </button>
      </button-group>,
    )
    return blocks
  }

  if (view.status === 'declined') {
    const who = view.actor ?? view.owner
    return [<p>🚫 已拒绝授权{...renderPersonSuffix(who)}</p>]
  }

  if (view.status === 'revoked') {
    const blocks: VNode[] = [<p>🔒 已撤销能力授权（会话仍保持独占）</p>]
    for (const item of view.items) {
      const detail = item.message ? `：${item.message}` : ''
      blocks.push(<small key={item.id}>{`${statusIcon(item.status)} ${item.title}${detail}`}</small>)
    }
    return blocks
  }

  const blocks: VNode[] = [<p><b>{titleText}</b></p>]
  if (p.reason !== undefined && String(p.reason).trim() !== '') {
    blocks.push(<p>{String(p.reason).trim()}</p>)
  }
  if (view.status === 'error' && view.message) {
    blocks.push(<p><span color="danger">{view.message}</span></p>)
  }

  if (options.length === 0) {
    blocks.push(<small>确认后本会话将仅对你及你授权的协作者开放交互。</small>)
    blocks.push(
      <button-group width="fill">
        <button variant="primary_filled" confirm={p.confirm} onClick={(e: unknown) => runGrant(e, [])}>
          认领并独占会话
        </button>
        <button onClick={runDecline}>暂不</button>
      </button-group>,
    )
    return blocks
  }

  if (options.length === 1) {
    const only = options[0]!
    const info = meta[only.id]!
    blocks.push(<p>{`• ${info.title}`}</p>)
    if (info.description) blocks.push(<small>{info.description}</small>)
    blocks.push(<small>授权后当前会话将由你独占，后续可通过 @bot 协作授权给其他成员。</small>)
    blocks.push(
      <button-group width="fill">
        <button variant="primary_filled" confirm={p.confirm} onClick={(e: unknown) => runGrant(e, [only.id])}>
          授权并独占会话
        </button>
        <button onClick={runDecline}>暂不授权</button>
      </button-group>,
    )
    return blocks
  }

  for (const opt of options) {
    const info = meta[opt.id]!
    const isChecked = checked[opt.id] !== false
    blocks.push(
      <input
        key={`cap:${opt.id}`}
        name={`cap_${opt.id}`}
        type="checkbox"
        label={info.title}
        value={isChecked}
        onChange={(event: unknown) => {
          if (checkAllowed(event) === null) return
          const nextVal =
            event !== null && typeof event === 'object' ? (event as { checked?: unknown }).checked === true : !isChecked
          setChecked((prev) => {
            const copy: Record<string, boolean> = {}
            for (const k of Object.keys(prev)) copy[k] = prev[k]!
            copy[opt.id] = nextVal
            return copy
          })
        }}
      />,
    )
    if (info.description) blocks.push(<small key={`desc:${opt.id}`}>{info.description}</small>)
  }
  blocks.push(<small>授权后当前会话将由你独占，后续可通过 @bot 协作授权给其他成员。</small>)
  blocks.push(
    <button-group width="fill">
      <button
        variant="primary_filled"
        confirm={p.confirm}
        onClick={(e: unknown) => {
          const chosen = optionIds.filter((id) => checked[id] !== false)
          if (chosen.length === 0) {
            cardHandle.toast('请至少勾选一项要授权的能力，或点击暂不授权', 'warning')
            return
          }
          runGrant(e, chosen)
        }}
      >
        授权选中项并独占
      </button>
      <button variant="primary" confirm={p.confirm} onClick={(e: unknown) => runGrant(e, optionIds)}>
        一键全部授权
      </button>
      <button onClick={runDecline}>暂不授权</button>
    </button-group>,
  )
  return blocks
}
