// Tabs: a button-group as the tab bar (the active tab is filled), conditional content below,
// `details` folding long content, and small sub-components.
import { useState } from 'dsh:card'

type Svc = { name: string; ok: boolean; p99: number }
type Props = { services?: Svc[]; incidents?: string[]; log?: string }

const DEFAULT: Required<Props> = {
  services: [{ name: 'chat-api', ok: true, p99: 820 }, { name: 'sso', ok: true, p99: 95 }, { name: 'file-parser', ok: false, p99: 4100 }],
  incidents: ['10:02 file-parser 超时率升高', '10:15 已扩容 2 → 4 实例'],
  log: 'ERROR timeout after 4000ms\n  at parse (parser.ts:88)\n  at handle (server.ts:41)',
}

const TABS = [{ id: 'overview', label: '概览' }, { id: 'services', label: '服务' }, { id: 'incidents', label: '事件' }]

function Tabs(p: { tab: string; onPick: (id: string) => void }) {
  return (
    <button-group width="fill">
      {TABS.map(t => (
        <button key={t.id} size="small" variant={t.id === p.tab ? 'primary_filled' : 'default'} onClick={() => p.onPick(t.id)}>
          {t.label}
        </button>
      ))}
    </button-group>
  )
}

function Status(p: { ok: boolean }) {
  return p.ok ? <span color="success">正常</span> : <span color="danger">异常</span>
}

export default function Dashboard(props: Props) {
  const { services, incidents, log } = { ...DEFAULT, ...props }
  const [tab, setTab] = useState('overview')
  const bad = services.filter(s => !s.ok)

  return (
    <message>
      <title theme={bad.length ? 'danger' : 'success'} subtitle={bad.length ? `${bad.length} 个服务异常` : '全部正常'}>
        🩺 服务健康
      </title>
      <Tabs tab={tab} onPick={setTab} />
      {tab === 'overview' && (
        <>
          <p>共 <b>{services.length}</b> 个服务，异常 <b>{bad.length}</b> 个，今日事件 <b>{incidents.length}</b> 条。</p>
          {bad.length > 0 && <blockquote>异常：{bad.map(s => s.name).join('、')}</blockquote>}
        </>
      )}
      {tab === 'services' && (
        <table>
          <tr><th>服务</th><th>状态</th><th align="right">p99 (ms)</th></tr>
          {services.map(s => (
            <tr key={s.name}><td><code>{s.name}</code></td><td><Status ok={s.ok} /></td><td align="right">{s.p99}</td></tr>
          ))}
        </table>
      )}
      {tab === 'incidents' && (
        <>
          <ul>{incidents.map(x => <li key={x}>{x}</li>)}</ul>
          <details>
            <summary>最近错误日志</summary>
            <pre lang="text">{log}</pre>
          </details>
        </>
      )}
      <small>点击上方标签切换视图</small>
    </message>
  )
}
