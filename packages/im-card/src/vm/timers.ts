/**
 * Timers.
 *
 * The bridge is synchronous and the VM may be frozen at any moment, so a timer is never a real event loop entry: the
 * table holds absolute due times, the earliest one is reported to the host (`timers` op), and the host fires them with
 * `fireTimers(now)` — while the VM is live, or, where the deployment lets a due timer wake a card (`wakeOnTimer`), after
 * reviving it. A snapshot taken in between therefore carries the pending timers with it.
 *
 * @module dsh-im-card/vm/timers
 */
import { g, type TimerCallback } from './globals.ts'
import { host, reportError } from './host.ts'

/** One pending timer. */
interface Timer {
  /** Insertion order, used to break ties in due time. */
  id: number
  /** Absolute due time, epoch ms. */
  due: number
  fn: TimerCallback
  args: unknown[]
  /** Repeat interval in ms, or 0 for a one-shot timer. */
  interval: number
}

const timers = new Map<number, Timer>()
let nextTimerId = 1
/** Set while callbacks run: a callback that arms a timer must not answer the host from inside its own `timers` call. */
let firingTimers = false

/**
 * The earliest due time.
 * @returns epoch ms of the first timer to fire, or -1 when none is pending.
 */
export function nextTimerDue(): number {
  let min = -1
  for (const t of timers.values()) if (min === -1 || t.due < min) min = t.due
  return min
}

/** Tell the host when the next timer is due (skipped while {@link fireTimers} runs). */
function reportTimers(): void {
  if (!firingTimers) host('timers', String(nextTimerDue()))
}

/**
 * Arm a timer.
 * @param fn - the callback.
 * @param ms - delay in ms; intervals are clamped to at least 100 ms so a tight loop cannot starve the VM.
 * @param args - arguments handed back to the callback.
 * @param repeat - whether it is an interval.
 * @returns the timer id.
 */
function addTimer(fn: TimerCallback, ms: unknown, args: unknown[], repeat: boolean): number {
  if (typeof fn !== 'function') throw new TypeError('timer callback must be a function')
  let delay = Number(ms)
  if (!Number.isFinite(delay) || delay < 0) delay = 0
  if (repeat && delay < 100) delay = 100
  const id = nextTimerId++
  timers.set(id, { id, due: Date.now() + delay, fn, args, interval: repeat ? delay : 0 })
  reportTimers()
  return id
}

/**
 * Disarm a timer.
 * @param id - the id `setTimeout`/`setInterval` returned.
 */
function clearTimer(id: unknown): void {
  if (timers.delete(Number(id))) reportTimers()
}

/** Drop every timer, telling the host once (used when a card is frozen). */
export function clearTimers(): void {
  const hadTimers = timers.size > 0
  timers.clear()
  if (hadTimers) reportTimers()
}

/**
 * Run every timer that existed and was due at call time; intervals are re-armed.
 * @param nowMs - the time the host woke the VM for.
 */
export function fireTimers(nowMs: number): void {
  const now = Number(nowMs)
  const due = [...timers.values()].filter((t) => t.due <= now).sort((a, b) => a.due - b.due || a.id - b.id)
  firingTimers = true
  try {
    for (const t of due) {
      if (timers.get(t.id) !== t) continue // cleared by an earlier callback
      // An interval is re-armed from its own due time, but never in the past: waking up late runs it once, not once
      // per missed period.
      if (t.interval) t.due = Math.max(t.due + t.interval, now + 1)
      else timers.delete(t.id)
      try {
        t.fn(...t.args)
      } catch (e) {
        // Reported, not rethrown: one failing timer must not cancel the others.
        reportError(e)
      }
    }
  } finally {
    firingTimers = false
  }
  reportTimers()
}

/** Publish `setTimeout`, `setInterval`, `clearTimeout` and `clearInterval`. */
export function installTimers(): void {
  g.setTimeout = (fn, ms, ...args) => addTimer(fn, ms, args, false)
  g.setInterval = (fn, ms, ...args) => addTimer(fn, ms, args, true)
  g.clearTimeout = clearTimer
  g.clearInterval = clearTimer
}
