// Multi-step form built from buttons: environment → action → review & confirm → submitted.
// The submit click sends one self-contained summary to the agent, which then does the work.
import { useState, useCard, agent } from 'dsh:card'

const ENVS = ['dev', 'staging', 'prod']
const ACTIONS = [
  { id: 'restart', label: '重启服务' },
  { id: 'rollback', label: '回滚上一版' },
  { id: 'scale', label: '扩容 2 倍' },
]

type Props = { service?: string }

export default function Wizard({ service = 'chat-api' }: Props) {
  const [step, setStep] = useState(0)
  const [env, setEnv] = useState('')
  const [action, setAction] = useState('')
  const [by, setBy] = useState('')
  const card = useCard()
  const act = ACTIONS.find(a => a.id === action)

  const submit = (e: { user: { id: string; name?: string } }) => {
    const r = agent.send(`用户 ${e.user.name ?? e.user.id}（${e.user.id}）确认操作：服务 ${service}，环境 ${env}，动作 ${action}（${act?.label}）。请执行并在群里回报结果。`)
    if (!r.ok) return card.toast(`提交失败：${r.error}`, 'error')
    setBy(e.user.id)
    setStep(3)
    card.toast('已提交', 'success')
  }

  const steps = ['选择环境', '选择操作', '确认']
  const header = (
    <title theme={step === 3 ? 'success' : env === 'prod' ? 'danger' : 'info'} subtitle={step < 3 ? `第 ${step + 1}/3 步 · ${steps[step]}` : '已提交'}>
      🛠 运维操作 · {service}
    </title>
  )

  if (step === 3) {
    return (
      <message>
        {header}
        <p>已提交 <b>{act?.label}</b> @ <code>{env}</code>，提交人 <at type="user" id={by} /></p>
        <small>助手正在处理，结果会在群里回复</small>
      </message>
    )
  }

  return (
    <message>
      {header}
      {step === 0 && (
        <>
          <p>要操作哪个环境？</p>
          <button-group width="fill">
            {ENVS.map(x => (
              <button key={x} variant={env === x ? 'primary_filled' : 'default'} onClick={() => setEnv(x)}>{x}</button>
            ))}
          </button-group>
        </>
      )}
      {step === 1 && (
        <>
          <p>环境 <code>{env}</code>，要做什么？</p>
          <button-group>
            {ACTIONS.map(a => (
              <button key={a.id} variant={action === a.id ? 'primary_filled' : 'default'} onClick={() => setAction(a.id)}>
                {a.label}
              </button>
            ))}
          </button-group>
        </>
      )}
      {step === 2 && (
        <table>
          <tr><th>项目</th><th>值</th></tr>
          <tr><td>服务</td><td>{service}</td></tr>
          <tr><td>环境</td><td>{env === 'prod' ? <span color="danger">{env}</span> : env}</td></tr>
          <tr><td>操作</td><td>{act?.label}</td></tr>
        </table>
      )}
      <hr />
      <button-group align="right">
        {step > 0 && <button variant="text" onClick={() => setStep(step - 1)}>上一步</button>}
        {step < 2 && (
          <button variant="primary" disabled={step === 0 ? !env : !action} disabledTip="请先选择一项" onClick={() => setStep(step + 1)}>
            下一步
          </button>
        )}
        {step === 2 && (
          <button variant={env === 'prod' ? 'danger_filled' : 'primary_filled'} icon="done_outlined"
            confirm={{ title: '确认执行', text: `将在 ${env} 上执行「${act?.label}」，确定吗？` }} onClick={submit}>
            提交
          </button>
        )}
      </button-group>
    </message>
  )
}
