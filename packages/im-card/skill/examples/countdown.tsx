// Countdown with stop / restart. The interval runs inside the card VM, only while the bot has the card loaded: it stops
// when the card is freed, and a restart ends it too — the card counts down again after the next click, not by itself.
// Each tick re-publishes the whole message, so tick once per second at most (prefer 5–10 s for long timers).
import { useState, useEffect, useCard } from 'dsh:card'

type Props = { label?: string; seconds?: number }

export default function Countdown({ label = '午饭投票截止', seconds = 60 }: Props) {
  const [end, setEnd] = useState(() => Date.now() + seconds * 1000)
  const [now, setNow] = useState(() => Date.now())
  const [running, setRunning] = useState(true)
  const card = useCard()
  const left = Math.max(0, Math.ceil((end - now) / 1000))

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id) // runs when `running` changes or the card unmounts
  }, [running])

  useEffect(() => {
    if (running && left === 0) setRunning(false) // stops the interval through the effect above
  }, [left, running])

  const mm = String(Math.floor(left / 60)).padStart(2, '0')
  const ss = String(left % 60).padStart(2, '0')
  const theme = left === 0 ? 'danger' : left <= 10 ? 'warning' : running ? 'info' : 'default'

  return (
    <message>
      <title theme={theme} subtitle={left === 0 ? '时间到' : running ? '倒计时中' : '已暂停'}>⏱ {label}</title>
      <h2>{mm}:{ss}</h2>
      <button-group>
        {running
          ? <button variant="danger" onClick={() => { setRunning(false); card.toast('已暂停') }}>暂停</button>
          : left > 0 && (
            <button variant="primary" onClick={() => { setEnd(Date.now() + left * 1000); setNow(Date.now()); setRunning(true) }}>
              继续
            </button>
          )}
        <button variant="text" onClick={() => { setEnd(Date.now() + seconds * 1000); setNow(Date.now()); setRunning(true) }}>
          重新开始
        </button>
      </button-group>
    </message>
  )
}
