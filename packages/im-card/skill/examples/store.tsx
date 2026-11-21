// A tally kept in the card's data folder: `useStoredState` starts from the file, and every click writes it back, so
// the number survives a restart and a second card published from the same working directory reads the same value.
import { useStoredState } from 'dsh:card'
import type { ClickEvent } from 'dsh:card'

type Tally = { count: number; last?: string }

export default function Store() {
  const [tally, setTally] = useStoredState<Tally>('examples/tally.json', { count: 0 })

  return (
    <message>
      <title theme="info">📦 累计 {tally.count} 次</title>
      <p>值存在卡片自己的数据目录里，机器人重启后还在。</p>
      {tally.last === undefined ? <small>还没有人点过</small> : <small>最近一次：{tally.last}</small>}
      <button-group width="fill">
        <button variant="primary_filled" onClick={(e: ClickEvent) => setTally(t => ({ count: t.count + 1, last: e.user.id }))}>
          +1
        </button>
        <button onClick={() => setTally({ count: 0 })}>清零</button>
      </button-group>
    </message>
  )
}
