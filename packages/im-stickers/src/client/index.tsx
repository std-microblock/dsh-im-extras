/**
 * Browser half of `dsh-im-stickers`: the panel's 表情库 tab — filter, search, weights, the enabled switch, upload,
 * collecting a chat picture, classification jobs, batch edits, and the per-chat automatic sticker.
 */
import { Button, Input, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClientContext, PanelClient, TabProps } from './panel.ts'

interface Sticker {
  id: number
  source: 'upload' | 'chat'
  origin?: { chat: string; seq: number; index: number }
  title: string
  desc: string
  tags: string[]
  weight: number
  enabled: boolean
  format: 'static' | 'animated'
  width: number
  height: number
  size: number
  thumb: string
  uses: number
  lastUsed: number
  error: string
}
interface StickerType { id: string; name: string; desc: string }
interface Stats { total: number; enabled: number; undescribed: number; untagged: number; failed: number; byTag: Record<string, number> }
interface Job { kind: string; total: number; done: number; failed: number; running: boolean; current: string; errors: string[] }
interface Listing { items: Sticker[]; total: number; stats: Stats; types: StickerType[]; job: Job | null }
interface Auto { enabled: boolean; percent: number; gapMs: number; tag: string }
interface Result { ok: boolean; text: string }

const PAGE = 60
const UNTAGGED = '__untagged'

const styles = {
  bar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 } as const,
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(176px, 1fr))', gap: 10 } as const,
  card: { display: 'flex', flexDirection: 'column', gap: 6, padding: 8, position: 'relative' } as const,
  image: { width: '100%', height: 132, objectFit: 'contain', borderRadius: 8, background: 'var(--dsw-color-bg-secondary, rgba(127,127,127,.08))' } as const,
  desc: { fontSize: 12, lineHeight: 1.4, minHeight: 34, cursor: 'text', wordBreak: 'break-word' } as const,
  chip: (on: boolean) => ({ cursor: 'pointer', opacity: on ? 1 : 0.45, userSelect: 'none' }) as const,
  select: { height: 28, borderRadius: 8, padding: '0 8px' } as const,
  number: { width: 56, height: 24 } as const,
}

function StickersTab({ read, command, upload, url, toast, chats }: TabProps) {
  const [listing, setListing] = useState<Listing | undefined>()
  const [query, setQuery] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [enabled, setEnabled] = useState<'' | 'true' | 'false'>('')
  const [order, setOrder] = useState('weight')
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [editing, setEditing] = useState<number | undefined>()
  const [chat, setChat] = useState('')
  const [media, setMedia] = useState('')
  const [auto, setAuto] = useState<Auto | undefined>()
  const [version, setVersion] = useState(0)
  const files = useRef<HTMLInputElement>(null)
  const types = listing?.types ?? []
  const typeName = useMemo(() => new Map(types.map(t => [t.id, t.name])), [types])

  const reload = useCallback(() => { setVersion(v => v + 1) }, [])
  useEffect(() => {
    const untagged = tags.includes(UNTAGGED)
    void read<Listing>('', {
      q: query || undefined,
      tags: tags.filter(t => t !== UNTAGGED).join(',') || undefined,
      untagged: untagged || undefined,
      enabled: enabled || undefined,
      order,
      limit: PAGE,
      offset,
    }).then(setListing, error => { toast(String((error as Error).message)) })
  }, [read, query, tags, enabled, order, offset, version, toast])

  // Follow a running job.
  useEffect(() => {
    if (!listing?.job?.running) return
    const timer = setTimeout(reload, 1500)
    return () => { clearTimeout(timer) }
  }, [listing, reload])

  useEffect(() => {
    setAuto(undefined)
    if (chat) void read<{ auto?: Auto }>('chats', { chat }).then(r => { setAuto(r.auto) }, () => {})
  }, [read, chat, version])

  const run = async (body: Record<string, unknown>) => {
    try {
      const result = await command<Result>(body)
      toast(result.text)
      reload()
      return result
    } catch (error) {
      toast(String((error as Error).message))
      return undefined
    }
  }
  const toggleTag = (id: string) => { setOffset(0); setTags(current => current.includes(id) ? current.filter(t => t !== id) : [...current, id]) }
  const toggleSelected = (id: number) => {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const onUpload = async (list: FileList | null) => {
    if (!list || list.length === 0) return
    try {
      const result = await upload<{ results?: ({ id: number; created: boolean } | { error: string; name?: string })[]; text?: string }>('upload', [...list])
      const results = result.results ?? []
      const added = results.filter(r => 'id' in r && r.created).length
      const failed = results.filter(r => 'error' in r)
      toast(`新增 ${added} 个${results.length - added - failed.length > 0 ? `，${results.length - added - failed.length} 个已存在` : ''}${failed.length ? `，${failed.length} 个失败` : ''}`)
    } catch (error) {
      toast(String((error as Error).message))
    }
    if (files.current) files.current.value = ''
    reload()
  }
  const ids = [...selected]
  const job = listing?.job
  const stats = listing?.stats

  return (
    <div>
      <div className="im-toolbar" style={styles.bar}>
        <Input placeholder="搜索描述、标题或类型" value={query} onChange={e => { setOffset(0); setQuery(e.target.value) }} />
        <select style={styles.select} value={enabled} onChange={e => { setOffset(0); setEnabled(e.target.value as typeof enabled) }}>
          <option value="">全部</option><option value="true">已启用</option><option value="false">已停用</option>
        </select>
        <select style={styles.select} value={order} onChange={e => setOrder(e.target.value)}>
          <option value="weight">按权重</option><option value="uses">按使用次数</option><option value="recent">最近使用</option>
          <option value="newest">最新加入</option><option value="oldest">最早加入</option>
        </select>
        <input ref={files} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => { void onUpload(e.target.files) }} />
        <Button size="sm" variant="primary" onClick={() => files.current?.click()}>上传表情</Button>
        <Button size="sm" onClick={() => { void run({ action: 'classify' }) }} disabled={job?.running}>分类未描述的</Button>
        <Button size="sm" variant="ghost" onClick={reload}>刷新</Button>
      </div>

      <div style={styles.bar}>
        {types.map(t => (
          <span key={t.id} className="im-chip" style={styles.chip(tags.includes(t.id))} title={t.desc} onClick={() => toggleTag(t.id)}>
            {t.name} {stats?.byTag[t.id] ?? 0}
          </span>
        ))}
        <span className="im-chip" style={styles.chip(tags.includes(UNTAGGED))} onClick={() => toggleTag(UNTAGGED)}>未分类 {stats?.untagged ?? 0}</span>
        {stats !== undefined && (
          <span className="im-muted">共 {stats.total} 张，启用 {stats.enabled}，未描述 {stats.undescribed}{stats.failed ? `，失败 ${stats.failed}` : ''}</span>
        )}
      </div>

      {job && (job.running || job.errors.length > 0) && (
        <div className="im-card" style={{ ...styles.bar, padding: 8 }}>
          <span>{job.running ? '分类中' : '上次分类'} {job.done}/{job.total}{job.failed ? `（失败 ${job.failed}）` : ''} {job.current}</span>
          {job.running && <Button size="sm" onClick={() => { void run({ action: 'cancel-job' }) }}>停止</Button>}
          {!job.running && job.errors.slice(0, 3).map((error, i) => <span key={i} className="im-muted" style={{ fontSize: 12 }}>{error}</span>)}
        </div>
      )}

      <div className="im-card" style={{ ...styles.bar, padding: 8 }}>
        <select style={styles.select} value={chat} onChange={e => setChat(e.target.value)}>
          <option value="">选择会话…</option>
          {chats.map(c => <option key={c.chat} value={c.chat}>{c.name ?? c.chat}</option>)}
        </select>
        {chat && (
          <>
            <Input placeholder="图片编号，如 12.1" value={media} onChange={e => setMedia(e.target.value)} style={{ width: 120 }} />
            <Button size="sm" onClick={() => { void run({ action: 'collect', chat, media }) }} disabled={!media.trim()}>收藏为表情</Button>
            {auto !== undefined && (
              <>
                <Switch label="自动补表情" checked={auto.enabled} onChange={next => { void run({ action: 'set-chat', chat, enabled: next }) }} />
                <span>概率</span>
                <input type="number" min={0} max={100} style={styles.number} defaultValue={auto.percent} key={`${chat}-${auto.percent}`}
                  onBlur={e => { const percent = Number(e.target.value); if (percent !== auto.percent) void run({ action: 'set-chat', chat, percent }) }} />
                <span>%</span>
                <Button size="sm" variant="ghost" onClick={() => { void run({ action: 'set-chat', chat, clear: true }) }}>恢复配置默认</Button>
              </>
            )}
          </>
        )}
      </div>

      {ids.length > 0 && (
        <div className="im-card" style={{ ...styles.bar, padding: 8 }}>
          <span>已选 {ids.length} 张</span>
          <Button size="sm" onClick={() => { void run({ action: 'update-many', ids, enabled: true }) }}>启用</Button>
          <Button size="sm" onClick={() => { void run({ action: 'update-many', ids, enabled: false }) }}>停用</Button>
          <Button size="sm" onClick={() => {
            const weight = Number(prompt('权重（0-100）', '50'))
            if (Number.isFinite(weight)) void run({ action: 'update-many', ids, weight })
          }}>设权重</Button>
          <select style={styles.select} value="" onChange={e => { if (e.target.value) void run({ action: 'update-many', ids, addTags: [e.target.value] }) }}>
            <option value="">加类型…</option>
            {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select style={styles.select} value="" onChange={e => { if (e.target.value) void run({ action: 'update-many', ids, removeTags: [e.target.value] }) }}>
            <option value="">去类型…</option>
            {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <Button size="sm" onClick={() => { void run({ action: 'classify', ids, force: true }) }}>重新分类</Button>
          <Button size="sm" variant="outline" onClick={() => {
            if (confirm(`删除这 ${ids.length} 张表情？`)) void run({ action: 'remove', ids }).then(() => { setSelected(new Set()) })
          }}>删除</Button>
          <Button size="sm" variant="ghost" onClick={() => { setSelected(new Set()) }}>取消选择</Button>
          <Button size="sm" variant="ghost" onClick={() => { setSelected(new Set(listing?.items.map(i => i.id))) }}>全选本页</Button>
        </div>
      )}

      {listing?.items.length === 0 && <div className="im-empty">没有表情。上传图片，或在会话里用图片编号收藏。</div>}
      <div className="im-grid" style={styles.grid}>
        {listing?.items.map(item => (
          <div key={item.id} className="im-card" style={{ ...styles.card, opacity: item.enabled ? 1 : 0.55, outline: selected.has(item.id) ? '2px solid var(--dsw-color-accent, #4c8bf5)' : undefined }}>
            <img src={url('file', { sticker: item.id, thumb: 1 })} alt={item.desc} loading="lazy" style={styles.image} onClick={() => toggleSelected(item.id)} />
            <div style={styles.bar}>
              <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggleSelected(item.id)} />
              <strong>#{item.id}</strong>
              {item.format === 'animated' && <Tag tone="info">动图</Tag>}
              <span className="im-muted" style={{ fontSize: 12 }}>用过 {item.uses}</span>
            </div>
            {editing === item.id
              ? (
                <textarea autoFocus defaultValue={item.desc} rows={2} style={{ fontSize: 12 }}
                  onBlur={e => { setEditing(undefined); if (e.target.value !== item.desc) void run({ action: 'update', id: item.id, desc: e.target.value }) }} />
                )
              : <div style={styles.desc} title="点击编辑描述" onClick={() => setEditing(item.id)}>{item.desc || <span className="im-muted">（还没有描述）</span>}</div>}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {types.map(t => (
                <span key={t.id} className="im-chip" style={{ ...styles.chip(item.tags.includes(t.id)), fontSize: 11 }}
                  onClick={() => {
                    const next = item.tags.includes(t.id) ? item.tags.filter(tag => tag !== t.id) : [...item.tags, t.id]
                    void run({ action: 'update', id: item.id, tags: next })
                  }}>{typeName.get(t.id)}</span>
              ))}
            </div>
            <div style={styles.bar}>
              <span style={{ fontSize: 12 }}>权重</span>
              <input type="number" min={0} max={100} defaultValue={item.weight} key={`${item.id}-${item.weight}`} style={styles.number}
                onBlur={e => { const weight = Number(e.target.value); if (weight !== item.weight) void run({ action: 'update', id: item.id, weight }) }} />
              <Switch label="启用" checked={item.enabled} onChange={next => { void run({ action: 'update', id: item.id, enabled: next }) }} />
            </div>
            {item.error && <div style={{ fontSize: 11, color: 'var(--dsw-color-danger, #d33)' }}>{item.error}</div>}
            <div style={styles.bar}>
              <Button size="sm" variant="ghost" onClick={() => { void run({ action: 'classify', ids: [item.id], force: true }) }}>重新分类</Button>
              {chat && <Button size="sm" variant="ghost" onClick={() => { void run({ action: 'send', chat, id: item.id }) }}>发到会话</Button>}
            </div>
          </div>
        ))}
      </div>
      {listing !== undefined && listing.total > PAGE && (
        <div style={{ ...styles.bar, marginTop: 10 }}>
          <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>上一页</Button>
          <span className="im-muted">{offset + 1}–{Math.min(offset + PAGE, listing.total)} / {listing.total}</span>
          <Button size="sm" disabled={offset + PAGE >= listing.total} onClick={() => setOffset(offset + PAGE)}>下一页</Button>
        </div>
      )}
    </div>
  )
}

export const name = 'dsh-im-stickers'

/**
 * Register the sticker tab with the panel's browser half.
 * @param ctx - the client plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.inject(['imPanel'], (scoped) => {
    const panel = scoped.get('imPanel') as PanelClient
    scoped.effect(() => panel.tab({ id: 'stickers', title: '表情库', order: 60, component: StickersTab }), 'stickers tab')
  })
}
