/**
 * Browser half of `dsh-im-qq-panel`: the panel's “QQ 菜单面板” tab — the platform menu and panels next to the
 * configuration, the pending actions, and buttons to sync (or rehearse a sync) and to delete a panel.
 */
import { Button, Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useState } from 'react'
import type { ClientContext, PanelClient, TabProps } from './panel.ts'

interface MenuItem { type: string; name: string; send_message?: string; link?: string; switch?: { switch_id?: string }; sub_menu_items?: unknown[] }
interface PanelRecord { panel_id: string; scope?: string; target_type?: string; version?: number; panel?: { items?: { name?: string }[]; remark?: string } }
interface DesiredPanel { key: string; scope: string; targetType: string; source: string; remark: string; labels: string[] }
interface PanelAction { type: string; panelId?: string; panel?: { key: string }; reason?: string; message?: string; remark?: string; op?: string; openIds?: string[] }
interface Report {
  bot: string
  menu: { remote: { version: number; menu: { items?: MenuItem[] } }; desired: { items: MenuItem[] }; managed: boolean; plan: { changed: boolean; remoteItemCount: number; desiredItemCount: number } }
  desired: DesiredPanel[]
  records: PanelRecord[]
  panels: PanelAction[]
  warnings: string[]
}
interface State { bots: { id: string; online: boolean }[]; bot?: string; report?: Report; error?: string }

const ACTION: Record<string, { label: string; tone: TagTone }> = {
  create: { label: '新建', tone: 'success' },
  recreate: { label: '重建', tone: 'warning' },
  update: { label: '更新', tone: 'info' },
  unchanged: { label: '一致', tone: 'neutral' },
  target: { label: '关联对象', tone: 'info' },
  delete: { label: '删除', tone: 'danger' },
  warn: { label: '提示', tone: 'warning' },
}

const styles = {
  head: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 } as const,
  select: { height: 28, borderRadius: 8, padding: '0 8px' } as const,
  pre: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontSize: 13, lineHeight: 1.5 } as const,
}

function menuLine(item: MenuItem): string {
  const extra = item.type === 'send_message' ? item.send_message
    : item.type === 'link' ? item.link
      : item.type === 'switch' ? `switch_id=${item.switch?.switch_id ?? ''}`
        : `${(item.sub_menu_items ?? []).length} 个子项`
  return `[${item.type}] ${item.name}${extra ? ` → ${extra}` : ''}`
}

function QqPanelTab({ read, command, toast }: TabProps) {
  const [bot, setBot] = useState('')
  const [state, setState] = useState<State | undefined>()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')

  const load = useCallback(async () => {
    setBusy(true)
    try {
      setState(await read<State>('', { bot: bot || undefined }))
    } catch (error) {
      toast(String((error as Error).message ?? error))
    } finally {
      setBusy(false)
    }
  }, [read, bot, toast])

  useEffect(() => { void load() }, [load])

  const run = async (body: Record<string, unknown>) => {
    setBusy(true)
    try {
      const answer = await command({ ...body, ...state?.bot ? { bot: state.bot } : {} })
      setResult(answer.text)
      toast(answer.ok ? '完成' : '有失败项，见下方结果')
    } catch (error) {
      toast(String((error as Error).message ?? error))
    } finally {
      setBusy(false)
      void load()
    }
  }

  const report = state?.report
  const pending = report?.panels.filter(action => action.type !== 'unchanged' && action.type !== 'warn') ?? []
  return (
    <div>
      <div className="im-toolbar" style={styles.head}>
        <select style={styles.select} value={bot} onChange={e => setBot(e.target.value)}>
          <option value="">第一个在线的 QQ 机器人</option>
          {state?.bots.map(item => <option key={item.id} value={item.id}>{item.id}{item.online ? '' : '（离线）'}</option>)}
        </select>
        <Button size="sm" onClick={() => { void load() }} disabled={busy}>刷新</Button>
        <Button size="sm" onClick={() => { void run({ action: 'sync' }) }} disabled={busy || !report}>同步菜单与面板</Button>
        <Button size="sm" variant="outline" onClick={() => { void run({ action: 'sync', resources: ['menu'] }) }} disabled={busy || !report}>只同步菜单</Button>
        <Button size="sm" variant="outline" onClick={() => { void run({ action: 'sync', resources: ['panels'] }) }} disabled={busy || !report}>只同步面板</Button>
        <Button size="sm" variant="ghost" onClick={() => { void run({ action: 'sync', dryRun: true }) }} disabled={busy || !report}>演练</Button>
      </div>

      {state?.error && <div className="im-empty">{state.error}</div>}
      {result && <div className="im-card" style={{ marginBottom: 12 }}><pre style={styles.pre}>{result}</pre></div>}

      {report && (
        <>
          <div className="im-card" style={{ marginBottom: 12 }}>
            <div style={styles.head}>
              <strong>自定义菜单（单聊）</strong>
              <span className="im-chip">平台版本 {report.menu.remote.version}</span>
              {!report.menu.managed
                ? <Tag tone="neutral">配置为空，不改动平台</Tag>
                : report.menu.plan.changed
                  ? <Tag tone="warning">{report.menu.plan.remoteItemCount} → {report.menu.plan.desiredItemCount} 项待下发</Tag>
                  : <Tag tone="success">与配置一致</Tag>}
            </div>
            {(report.menu.remote.menu.items ?? []).length === 0
              ? <div className="im-muted">平台当前没有菜单项</div>
              : (report.menu.remote.menu.items ?? []).map((item, index) => <div key={index}>{index + 1}. {menuLine(item)}</div>)}
          </div>

          <div className="im-card" style={{ marginBottom: 12 }}>
            <div style={styles.head}>
              <strong>平台指令面板</strong>
              <span className="im-chip">{report.records.length} 个</span>
            </div>
            {report.records.length === 0 && <div className="im-muted">平台当前没有已生效的指令面板</div>}
            {report.records.length > 0 && (
              <table className="im-table">
                <thead><tr><th>panel_id</th><th>场景</th><th>范围</th><th>元素</th><th>版本</th><th>备注</th><th /></tr></thead>
                <tbody>
                  {report.records.map(record => (
                    <tr key={record.panel_id}>
                      <td><code>{record.panel_id}</code></td>
                      <td>{record.scope}</td>
                      <td>{record.target_type}</td>
                      <td title={(record.panel?.items ?? []).map(item => item.name).join('、')}>{(record.panel?.items ?? []).length}</td>
                      <td>{record.version ?? '-'}</td>
                      <td>{record.panel?.remark ?? '-'}</td>
                      <td>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => {
                          if (confirm(`删除面板 ${record.panel_id}？`)) void run({ action: 'delete', panelId: record.panel_id })
                        }}>删除</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="im-card" style={{ marginBottom: 12 }}>
            <div style={styles.head}>
              <strong>配置的面板</strong>
              {pending.length > 0 ? <Tag tone="warning">{pending.length} 个待处理动作</Tag> : <Tag tone="success">与平台一致</Tag>}
            </div>
            {report.desired.length === 0 && <div className="im-muted">配置中没有面板</div>}
            {report.desired.map(panel => {
              const actions = report.panels.filter(action => action.panel?.key === panel.key)
              return (
                <div key={panel.key} style={{ marginBottom: 8 }}>
                  <div style={styles.head}>
                    <strong>{panel.key}</strong>
                    <span className="im-chip">{panel.scope}</span>
                    <span className="im-chip">{panel.targetType}</span>
                    <span className="im-chip">{panel.source === 'commands' ? '按命令生成' : '手填'}</span>
                    {actions.map((action, index) => (
                      <Tag key={index} tone={ACTION[action.type]?.tone ?? 'neutral'}>
                        {ACTION[action.type]?.label ?? action.type}{action.op ? ` ${action.op} ${action.openIds?.length ?? 0}` : ''}{action.reason ? `：${action.reason}` : ''}
                      </Tag>
                    ))}
                  </div>
                  <div className="im-muted" style={{ fontSize: 12 }}>{panel.labels.join('、') || '（无元素）'}</div>
                </div>
              )
            })}
            {report.panels.filter(action => action.type === 'delete').map(action => (
              <div key={action.panelId} style={styles.head}><Tag tone="danger">删除</Tag><code>{action.panelId}</code><span>{action.remark}</span></div>
            ))}
          </div>

          {report.warnings.length > 0 && (
            <div className="im-card">
              {report.warnings.map((warning, index) => <div key={index} className="im-muted">警告：{warning}</div>)}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export const name = 'dsh-im-qq-panel'

/**
 * Register the tab with the panel's browser half.
 * @param ctx - the client plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.inject(['imPanel'], (scoped) => {
    const panel = scoped.get('imPanel') as PanelClient
    scoped.effect(() => panel.tab({ id: 'qq-panel', title: 'QQ 菜单面板', order: 70, component: QqPanelTab }), 'qq-panel tab')
  })
}
