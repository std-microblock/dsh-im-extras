/**
 * The presets: a one-tap confirmation, a form that sends what was filled in, and a stateful switch — no import, no
 * button plumbing. A click arrives at the agent as a message, and a used control is replaced by who answered.
 */
export default function QuickReply({ ticket = '#1024' }: { ticket?: string }) {
  return (
    <message>
      <title theme="info" subtitle="预设组件示例">工单 {ticket} 怎么处理？</title>
      <p>和客户确认过就可以直接结单，否则先补一份处理方案。</p>
      <PromptChoices
        senderName="张三"
        options={[
          { label: '结单', prompt: `确认结单 ${ticket}`, variant: 'danger_filled' },
          { label: '转人工', prompt: `把 ${ticket} 转给人工` },
        ]}
      />
      <hr />
      <PromptForm
        submitLabel="提交处理方案"
        prompt={`工单 ${ticket} 的处理方案：{action}｜优先级：{level}｜需要回电：{callback}｜紧急：{urgent}`}
        fields={[
          { name: 'action', label: '处理动作', placeholder: '例如：重置限流' },
          { name: 'level', label: '优先级', type: 'select', options: ['高', '中', '低'], value: '中' },
          { name: 'callback', label: '需要回电', type: 'checkbox' },
          { name: 'urgent', label: '紧急', type: 'switch' },
        ]}
      />
      <small>快捷按钮只认发起人，点一次就换成「谁选了哪一项」</small>
    </message>
  )
}
