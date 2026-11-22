// Single-choice poll: one vote per user (re-voting moves the vote), counts and voters per option,
// and a close button that only `props.owner` (a platform user id) may use when it is given.
import { useState, useCard, agent } from 'dsh:card'

type Props = { question?: string; options?: string[]; owner?: string }

export default function Poll({ question = '周五团建去哪？', options = ['爬山', '桌游', '火锅'], owner }: Props) {
  const [votes, setVotes] = useState({} as Record<string, number>) // user id -> option index
  const [closed, setClosed] = useState(false)
  const card = useCard()
  const total = Object.keys(votes).length

  const vote = (e: CardEvent, i: number) => {
    if (votes[e.user.id] === i) return card.toast('你已经投过这一项了', 'info')
    setVotes({ ...votes, [e.user.id]: i })
    card.toast(`已投给「${options[i]}」`, 'success')
  }

  const close = (e: CardEvent) => {
    if (owner && e.user.id !== owner) return card.toast('只有发起人可以结束投票', 'warning')
    setClosed(true)
    const lines = options.map((o, i) => `${o}: ${Object.values(votes).filter(v => v === i).length}`)
    agent.send(`投票「${question}」已由 ${e.user.id} 结束，共 ${total} 票。\n${lines.join('\n')}`)
    card.close()
  }

  return (
    <message>
      <title theme={closed ? 'success' : 'info'} subtitle={closed ? '投票已结束' : `已有 ${total} 人投票`}>
        📊 {question}
      </title>
      {options.map((o, i) => {
        const voters = Object.keys(votes).filter(id => votes[id] === i)
        const pct = total ? Math.round((voters.length / total) * 100) : 0
        return (
          <p key={o}>
            <b>{o}</b> · {voters.length} 票 ({pct}%){' '}
            {voters.map(id => <at key={id} type="user" id={id} />)}
          </p>
        )
      })}
      {!closed && (
        <button-group width="fill">
          {options.map((o, i) => (
            <button key={o} variant="primary" onClick={(e: CardEvent) => vote(e, i)}>{o}</button>
          ))}
        </button-group>
      )}
      {!closed && (
        <button variant="danger_text" size="small" confirm={{ title: '结束投票', text: '结束后不能再投票，确定吗？' }} onClick={close}>
          结束投票
        </button>
      )}
      <small>每人一票，再次点击其他选项可改票</small>
    </message>
  )
}

type CardEvent = { user: { id: string; name?: string }; data?: string; time: number }
