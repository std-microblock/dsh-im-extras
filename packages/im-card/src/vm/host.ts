/**
 * The host bridge: the only way out of the VM.
 *
 * Every call is synchronous and carries strings, because that is all `__host(op, payload)` accepts. The ops and their
 * payloads are the host's business (`src/engine.ts` forwards them to the {@link CardVmHost} the owner provides); this
 * module only shapes the calls and keeps a failure of the bridge itself from escaping into a card.
 *
 * @module dsh-im-card/vm/host
 */
import { g } from './globals.ts'

/**
 * Call the host.
 * @param op - the operation (`schedule`, `toast`, `agent`, `fs`, `fetch`, `close`, `log`, `error`, `timers`).
 * @param payload - the payload, already serialized; absent means `''`.
 * @returns the reply, always a string (`''` when the host answered nothing).
 */
export function host(op: string, payload?: string): string {
  const r = g.__host(op, payload === undefined ? '' : String(payload))
  return r == null ? '' : String(r)
}

/**
 * Format an error as `<message>\n<stack>`.
 * @param e - the thrown value.
 * @returns what the host records for it.
 */
export function errorText(e: unknown): string {
  if (e instanceof Error) return String(e.message) + '\n' + String(e.stack || '')
  try {
    return typeof e === 'string' ? e : JSON.stringify(e) ?? String(e)
  } catch {
    // Unserializable value (cycle, BigInt): fall back to String().
    return String(e)
  }
}

/**
 * Report an uncaught error to the host, without letting a failing bridge escape.
 * @param e - the thrown value.
 */
export function reportError(e: unknown): void {
  try {
    host('error', errorText(e))
  } catch {
    // The host's error channel itself failed; nothing else can report it.
  }
}

/**
 * Render one `console` argument as text.
 * @param v - the argument a card passed.
 * @returns its cheapest readable form.
 */
export function formatArg(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Error) return v.stack ? String(v.message) + '\n' + v.stack : String(v)
  if (v === undefined || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') return String(v)
  try {
    const s = JSON.stringify(v)
    return s === undefined ? String(v) : s
  } catch {
    // Cyclic or otherwise unserializable object.
    return String(v)
  }
}

/**
 * One `console` method: joins its arguments and reports them as the `log` op.
 * @param level - `log`, `warn` or `error`, as the host records it.
 */
function makeLogger(level: string): (...args: unknown[]) => void {
  return function (...args) {
    host('log', JSON.stringify({ level, text: args.map(formatArg).join(' ') }))
  }
}

/** Replace the VM's `console` with one that reports through the host (card logs never reach the chat). */
export function installConsole(): void {
  g.console = {
    log: makeLogger('log'),
    info: makeLogger('log'),
    debug: makeLogger('log'),
    warn: makeLogger('warn'),
    error: makeLogger('error'),
  }
}

/** Provide `queueMicrotask` when the engine did not (QuickJS has it, but the runtime does not rely on that). */
export function installMicrotask(): void {
  if (typeof g.queueMicrotask !== 'function') {
    g.queueMicrotask = function (fn) {
      Promise.resolve().then(fn).then(undefined, reportError)
    }
  }
}
