/**
 * The two things a card can say to the world outside itself: a message to the agent that published it, and a toast to
 * the person whose click is being handled.
 *
 * @module dsh-im-card/vm/actions
 */
import { host } from './host.ts'

/** Result of a message to the agent. */
export interface SendResult {
  ok: boolean
  error?: string
}

/** The toast types the platform knows; anything else becomes `info`. */
const TOAST_TYPES = ['info', 'success', 'warning', 'error'] as const

/** What a card asks of itself: a toast, a freeze, a message to the agent. */
export interface CardHandle {
  /** Show a short notice to the person whose click is being handled (a no-op outside a click). */
  toast(content: unknown, type?: unknown): void
  /** Ask to be frozen: what the handler set is shown, then every interaction stops. */
  close(): void
  /** Send a message to the agent that published the card. */
  send(text: unknown): SendResult
}

/**
 * Narrow a toast type.
 * @param type - what the card passed.
 * @returns one of the four types, `info` for anything else.
 */
function toastType(type: unknown): (typeof TOAST_TYPES)[number] {
  return TOAST_TYPES.includes(type as (typeof TOAST_TYPES)[number]) ? (type as (typeof TOAST_TYPES)[number]) : 'info'
}

/**
 * Send one message to the agent that owns the card.
 * @param text - the text; it is stringified.
 * @returns what the host answered; a reply that is not JSON counts as a failed send.
 */
export function send(text: unknown): SendResult {
  const reply = host('agent', String(text))
  try {
    return JSON.parse(reply) as SendResult
  } catch {
    // A non-JSON host reply is reported as a failed send.
    return { ok: false, error: 'invalid host reply: ' + reply }
  }
}

/** The agent as a card sees it (`agent.send`). */
export const agent = { send }

/** What `useCard()` returns; one object for the whole VM, because a card has nothing per-call to carry. */
export const cardHandle: CardHandle = {
  toast(content, type) {
    host('toast', JSON.stringify({ content: String(content), type: toastType(type) }))
  },
  close() {
    host('close', '')
  },
  send,
}

/**
 * The card itself: `toast`, `close` and `send`.
 * @returns the handle of the card being rendered.
 */
export function useCard(): CardHandle {
  return cardHandle
}

/** Listeners subscribed to host-pushed events, keyed by channel name. */
const hostEventListeners = new Map<string, Set<(data: unknown) => void>>()

/**
 * Invoke a synchronous host action (used by trusted preset components).
 * @param name - host action name.
 * @param payload - JSON-serializable payload.
 * @returns parsed JSON object from the host, or `{ ok: false, error }`.
 */
export function callHostAction(name: string, payload: unknown): Record<string, unknown> {
  const reply = host('action', JSON.stringify({ name, payload }))
  try {
    const parsed: unknown = JSON.parse(reply)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { ok: false, error: 'invalid host action reply' }
  } catch {
    return { ok: false, error: 'invalid host action reply: ' + reply }
  }
}

/**
 * Subscribe to a host-pushed event channel inside a preset component.
 * @param channel - channel name.
 * @param listener - callback invoked when the host pushes to that channel.
 * @returns disposer removing the subscription.
 */
export function onHostEvent(channel: string, listener: (data: unknown) => void): () => void {
  let set = hostEventListeners.get(channel)
  if (set === undefined) {
    set = new Set()
    hostEventListeners.set(channel, set)
  }
  set.add(listener)
  return () => {
    const current = hostEventListeners.get(channel)
    if (current === undefined) return
    current.delete(listener)
    if (current.size === 0) hostEventListeners.delete(channel)
  }
}

/**
 * Dispatch one host-originated event to subscribed listeners (`__card.pushEvent`).
 * @param channel - channel name.
 * @param dataJson - JSON payload string.
 * @returns `{ handled }` as JSON.
 */
export function dispatchHostEvent(channel: string, dataJson: string): string {
  const listeners = hostEventListeners.get(String(channel))
  if (listeners === undefined || listeners.size === 0) return JSON.stringify({ handled: false })
  let data: unknown
  try {
    data = dataJson ? JSON.parse(dataJson) : undefined
  } catch {
    data = undefined
  }
  let handled = false
  for (const fn of [...listeners]) {
    handled = true
    fn(data)
  }
  return JSON.stringify({ handled })
}
