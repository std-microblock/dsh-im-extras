/**
 * Browser half of `dsh-im-polish`: the panel's 润色 tab — every polish decision with the text before and after, the
 * dropped sends with their reason, a per-chat switch, and a preview box.
 */
import { Button, Input, Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ClientContext, PanelClient, TabProps } from './panel.ts'

interface PolishRecord {
  id: string
  at: number
  chat: string
  session?: string
  action: 'rewritten' | 'kept' | 'dropped'
  original: string
  result: string
  reason?: string
  dropMessage?: string
  subs: string[]
  similarity?: number
  similarTo?: string
  attempts: { raw: string; verdict: string }[]
  model?: string
  durationMs: number
}

interface PolishStats { total: number; rewritten: number; kept: number; dropped: number; reasons: Record<string, number> }
interface ChatOverride { chat: string; enabled?: boolean }
interface Listing { records: PolishRecord[]; stats: PolishStats; overrides: ChatOverride[] }
interface ChatState { enabled: boolean; style: { main: string; subs: string[] }; note: string }
interface Preview { action: PolishRecord['action']; text: string; reason?: string; dropMessage?: string; subs: string[] }

const ACTIONS: { id: '' | PolishRecord['action']; label: string }[] = [
  { id: '', label: '全部' }, { id: 'rewritten', label: '已改写' }, { id: 'kept', label: '发原文' }, { id: 'dropped', label: '被拦下' },
]
const TONE: Record<PolishRecord['action'], TagTone> = { rewritten: 'success', kept: 'neutral', dropped: 'danger' }
const LABEL: Record<PolishRecord['action'], string> = { rewritten: '已改写', kept: '发原文', dropped: '被拦下' }
const REASONS: Record<string, string> = {
  'no-route': '没有模型路由', 'skip-ignored': '模型想跳过但不像重复', 'rewrite-similar': '改写和之前太像，发原文',
  unchanged: '改写与原文相同', 'repeat-allowed': '重复但配置允许发出', repeat: '与最近发言重复', 'model-skip': '模型判定内容重复',
}
const PAGE = 50

function reasonText(reason: string | undefined): string {
  if (!reason) return ''
  const [head = '', ...rest] = reason.split(' ')
  if (head === 'rejected') return `改写没通过安全校验：${rest.join(' ')}`
  if (head === 'error') return `模型调用失败：${rest.join(' ')}`
  return REASONS[head] ?? reason
}

function time(at: number): string {
  const date = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const styles = {
  columns: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 } as const,
  text: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontSize: 13, lineHeight: 1.5 } as const,
  label: { fontSize: 12, opacity: 0.6, marginBottom: 4 } as const,
  head: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 } as const,
  select: { height: 28, borderRadius: 8, padding: '0 8px' } as const,
}

function PolishTab({ read, command, toast, chats, openSession }: TabProps) {
  const [chat, setChat] = useState('')
  const [action, setAction] = useState<'' | PolishRecord['action']>('')
  const [query, setQuery] = useState('')
  const [listing, setListing] = useState<Listing | undefined>()
  const [more, setMore] = useState(false)
  const [state, setState] = useState<ChatState | undefined>()
  const [draft, setDraft] = useState('')
  const [preview, setPreview] = useState<Preview | undefined>()
  const [loading, setLoading] = useState(false)
  const names = useMemo(() => new Map(chats.map(c => [c.chat, c.name ?? c.chat])), [chats])

  const load = useCallback(async (before?: string) => {
    setLoading(true)
    try {
      const page = await read<Listing>('', { chat: chat || undefined, action: action || undefined, q: query || undefined, before, limit: PAGE })
      setListing(previous => before === undefined || previous === undefined ? page : { ...page, records: [...previous.records, ...page.records] })
      setMore(page.records.length >= PAGE)
    } catch (error) {
      toast(String((error as Error).message ?? error))
    } finally {
      setLoading(false)
    }
  }, [read, chat, action, query, toast])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    setState(undefined)
    if (chat) void read<ChatState>('chat', { chat }).then(setState, () => {})
  }, [read, chat])

  const override = listing?.overrides.find(o => o.chat === chat)
  const switchChat = async (enabled: boolean | null) => {
    const result = await command({ action: 'set-chat', chat, enabled })
    toast(result.text)
    void read<ChatState>('chat', { chat }).then(setState, () => {})
    void load()
  }
  const runPreview = async () => {
    if (!chat || !draft.trim()) { toast('先选一个会话并写一句话'); return }
    try { setPreview(await command<Preview>({ action: 'preview', chat, text: draft })) } catch (error) { toast(String((error as Error).message)) }
  }
  const clear = async () => {
    if (!confirm(chat ? '删除这个会话的全部润色记录？' : '删除全部润色记录？')) return
    toast((await command({ action: 'clear', ...chat ? { chat } : {} })).text)
    void load()
  }

  const stats = listing?.stats
  return (
    <div>
      <div className="im-toolbar" style={styles.head}>
        <select style={styles.select} value={chat} onChange={e => setChat(e.target.value)}>
          <option value="">全部会话</option>
          {chats.map(c => <option key={c.chat} value={c.chat}>{c.name ?? c.chat}</option>)}
        </select>
        <select style={styles.select} value={action} onChange={e => setAction(e.target.value as typeof action)}>
          {ACTIONS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
        <Input placeholder="搜索原文或结果" value={query} onChange={e => setQuery(e.target.value)} />
        <Button size="sm" onClick={() => { void load() }} disabled={loading}>刷新</Button>
        <Button size="sm" variant="outline" onClick={() => { void clear() }}>清空记录</Button>
      </div>

      {stats !== undefined && (
        <div style={styles.head}>
          <span className="im-chip">共 {stats.total}</span>
          <span className="im-chip">改写 {stats.rewritten}</span>
          <span className="im-chip">发原文 {stats.kept}</span>
          <span className="im-chip">拦下 {stats.dropped}</span>
          {Object.entries(stats.reasons).map(([reason, count]) => (
            <span key={reason} className="im-chip im-muted">{reasonText(reason)} {count}</span>
          ))}
        </div>
      )}

      {chat && (
        <div className="im-card" style={{ marginBottom: 12 }}>
          <div style={styles.head}>
            <strong>{names.get(chat) ?? chat}</strong>
            {state !== undefined && <Tag tone={state.enabled ? 'success' : 'neutral'}>{state.enabled ? '润色开启' : '润色关闭'}</Tag>}
            {override?.enabled !== undefined && <span className="im-muted">（面板设置）</span>}
            <Button size="sm" onClick={() => { void switchChat(true) }}>开启</Button>
            <Button size="sm" onClick={() => { void switchChat(false) }}>关闭</Button>
            <Button size="sm" variant="ghost" onClick={() => { void switchChat(null) }}>恢复配置默认</Button>
          </div>
          {state !== undefined && (
            <div className="im-muted" style={{ fontSize: 12 }}>
              主风格：{state.style.main}；子风格 {state.style.subs.length} 条{state.note ? `；额外要求：${state.note}` : ''}
            </div>
          )}
          <div style={{ ...styles.head, marginTop: 8 }}>
            <Input placeholder="写一句话，看看会被改成什么（不会发送）" value={draft} onChange={e => setDraft(e.target.value)} style={{ minWidth: 320 }} />
            <Button size="sm" onClick={() => { void runPreview() }}>试一试</Button>
          </div>
          {preview !== undefined && (
            <div style={styles.head}>
              <Tag tone={TONE[preview.action]}>{LABEL[preview.action]}</Tag>
              <span>{preview.action === 'dropped' ? preview.dropMessage : preview.text}</span>
              {preview.reason && <span className="im-muted">{reasonText(preview.reason)}</span>}
            </div>
          )}
        </div>
      )}

      {listing?.records.length === 0 && <div className="im-empty">没有润色记录</div>}
      {listing?.records.map(record => (
        <div key={record.id} className="im-card" style={{ marginBottom: 8 }}>
          <div style={styles.head}>
            <Tag tone={TONE[record.action]}>{LABEL[record.action]}</Tag>
            <span className="im-muted">{time(record.at)}</span>
            <span>{names.get(record.chat) ?? record.chat}</span>
            {record.session && <a href="#" onClick={e => { e.preventDefault(); openSession(record.session!) }}>会话</a>}
            {record.reason && <span className="im-muted">{reasonText(record.reason)}</span>}
            {record.similarity !== undefined && <span className="im-muted">相似度 {record.similarity.toFixed(2)}</span>}
            <span className="im-muted">{record.durationMs} ms{record.model ? ` · ${record.model}` : ''}</span>
          </div>
          <div style={styles.columns}>
            <div>
              <div style={styles.label}>改写前</div>
              <p style={styles.text}>{record.original}</p>
            </div>
            <div>
              <div style={styles.label}>{record.action === 'dropped' ? '没有发出' : '发出的'}</div>
              <p style={{ ...styles.text, ...record.action === 'dropped' ? { textDecoration: 'line-through', opacity: 0.6 } : {} }}>{record.result}</p>
            </div>
          </div>
          {record.similarTo && <div className="im-muted" style={{ fontSize: 12, marginTop: 6 }}>像这句：{record.similarTo}</div>}
          {record.dropMessage && <div className="im-muted" style={{ fontSize: 12, marginTop: 6 }}>告诉 agent：{record.dropMessage}</div>}
          {(record.subs.length > 0 || record.attempts.length > 0) && (
            <details style={{ marginTop: 6, fontSize: 12 }}>
              <summary className="im-muted">子风格与模型回答</summary>
              {record.subs.length > 0 && <div>子风格：{record.subs.join('；')}</div>}
              {record.attempts.map((attempt, index) => (
                <div key={index}><code>{attempt.verdict}</code> {attempt.raw}</div>
              ))}
            </details>
          )}
        </div>
      ))}
      {more && (
        <Button size="sm" onClick={() => { void load(listing?.records.at(-1)?.id) }} disabled={loading}>更早的记录</Button>
      )}
    </div>
  )
}

export const name = 'dsh-im-polish'

/**
 * Register the polish tab with the panel's browser half.
 * @param ctx - the client plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.inject(['imPanel'], (scoped) => {
    const panel = scoped.get('imPanel') as PanelClient
    scoped.effect(() => panel.tab({ id: 'polish', title: '润色', order: 50, component: PolishTab }), 'polish tab')
  })
}
