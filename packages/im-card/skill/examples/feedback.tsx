import { useState } from 'dsh:card'

/**
 * Real form controls: a `<select>` and a live `<input type="checkbox">` report their own changes, and a `<form>`
 * collects the rest when its submit button is clicked (`event.values`, keyed by each control's `name`).
 *
 * A card republishes its whole message on every change, so every control is fed back through `value` from the state its
 * own callback wrote — otherwise the next republish would show it empty again.
 */
export default function Feedback() {
  const [level, setLevel] = useState('中')
  const [tags, setTags] = useState<string[]>([])
  const [urgent, setUrgent] = useState(false)
  const [sent, setSent] = useState('')
  if (sent) return <message><p>✅ 已提交：{sent}</p></message>
  return (
    <message>
      <title subtitle="表单控件示例">提交反馈</title>
      <p><b>优先级</b></p>
      <select name="level" placeholder="选择优先级" value={level} onSelect={e => setLevel(e.values[0] ?? '中')}>
        {['低', '中', '高'].map(x => <option key={x} value={x}>{x}</option>)}
      </select>
      <p><b>分类</b>（可多选）</p>
      <select multiple name="tags" value={tags} onSelect={e => setTags(e.values)}>
        {['界面', '性能', '文档'].map(t => <option key={t} value={t}>{t}</option>)}
      </select>
      <input name="urgent" type="checkbox" label="需要尽快处理" value={urgent} onChange={e => setUrgent(e.checked)} />
      <form name="feedback">
        <input name="title" label="标题" placeholder="一句话概括" required maxLength={60} />
        <input name="detail" type="multiline" label="详情" placeholder="发生了什么" maxLength={500} />
        <button type="submit" variant="primary_filled" width="fill"
          confirm={{ title: '确认提交', text: `优先级：${level}` }}
          onClick={(e) => {
            const values = e.values ?? {}
            const title = String(values.title ?? '')
            // The submit is the settled truth for the form's own fields; the live controls already kept their state.
            const picked = Array.isArray(values.tags) ? values.tags : tags
            setTags(picked)
            const isUrgent = values.urgent === true || urgent
            setUrgent(isUrgent)
            const tagText = picked.join('、')
            setSent(`${title || '（未填写标题）'}（${level}${tagText ? `，${tagText}` : ''}${isUrgent ? '，紧急' : ''}）`)
          }}>提交</button>
      </form>
      <small>下拉框与勾选框即时生效，表单字段在点击提交时一起送达</small>
    </message>
  )
}
