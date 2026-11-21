// Checklist: tap an item to toggle it; a progress line and a header color that turns green when done.
import { useState, useCard } from 'dsh:card'

type Props = { title?: string; items?: string[] }

export default function Checklist({ title = '发布前检查', items = ['合并主分支', '跑完测试', '更新文档', '通知值班'] }: Props) {
  const [done, setDone] = useState([] as number[])
  const card = useCard()
  const all = done.length === items.length

  const toggle = (i: number) => {
    const next = done.includes(i) ? done.filter(x => x !== i) : [...done, i]
    setDone(next)
    if (next.length === items.length) card.toast('全部完成 🎉', 'success')
  }

  const bar = '■'.repeat(done.length) + '□'.repeat(items.length - done.length)

  return (
    <message>
      <title theme={all ? 'success' : 'warning'} subtitle={`${done.length}/${items.length} 已完成`}>✅ {title}</title>
      <ul>
        {items.map((item, i) => (
          <li key={item} checked={done.includes(i)}>{done.includes(i) ? <s>{item}</s> : item}</li>
        ))}
      </ul>
      <p><span color={all ? 'success' : 'muted'}>{bar}</span> {Math.round((done.length / items.length) * 100)}%</p>
      <button-group>
        {items.map((item, i) => (
          <button key={item} size="small" variant={done.includes(i) ? 'primary_filled' : 'default'}
            icon={done.includes(i) ? 'done_outlined' : undefined} onClick={() => toggle(i)}>
            {item}
          </button>
        ))}
      </button-group>
      {done.length > 0 && <button variant="text" size="small" onClick={() => setDone([])}>全部重置</button>}
    </message>
  )
}
