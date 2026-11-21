// Paginated list from props.items: prev / page indicator / next, plus jump to first / last.
import { useState } from 'dsh:card'

type Item = { title: string; detail?: string }
type Props = { title?: string; items?: Item[]; pageSize?: number }

const SAMPLE: Item[] = Array.from({ length: 23 }, (_, i) => ({ title: `工单 #${1001 + i}`, detail: i % 3 ? '处理中' : '待分配' }))

export default function Pager({ title = '待处理工单', items = SAMPLE, pageSize = 5 }: Props) {
  const [page, setPage] = useState(0)
  const pages = Math.max(1, Math.ceil(items.length / pageSize))
  const at = Math.min(page, pages - 1) // props may shrink; clamp instead of storing derived state
  const rows = items.slice(at * pageSize, (at + 1) * pageSize)

  return (
    <message>
      <title theme="info" subtitle={`共 ${items.length} 条`}>📋 {title}</title>
      {rows.length === 0 ? <p>暂无数据</p> : (
        <ol start={at * pageSize + 1}>
          {rows.map(r => <li key={r.title}><b>{r.title}</b>{r.detail ? <span color="muted"> · {r.detail}</span> : null}</li>)}
        </ol>
      )}
      <button-group width="fill">
        <button size="small" disabled={at === 0} onClick={() => setPage(0)}>« 首页</button>
        <button size="small" disabled={at === 0} onClick={() => setPage(at - 1)}>‹ 上一页</button>
        {/* a button always needs onClick (or type="link"); a no-op handler makes a disabled label */}
        <button size="small" variant="text" disabled>{`${at + 1} / ${pages}`}</button>
        <button size="small" disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>下一页 ›</button>
        <button size="small" disabled={at >= pages - 1} onClick={() => setPage(pages - 1)}>末页 »</button>
      </button-group>
    </message>
  )
}
