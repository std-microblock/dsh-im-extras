/**
 * The card engine: one QuickJS VM per live card, the in-VM runtime, the module loader over a compiled bundle, and
 * whole-VM snapshots.
 *
 * - **Snapshots.** A card's state is the VM memory itself. {@link CardVm.snapshot} XORs that memory with the memory of
 *   a pristine VM that ran only the runtime (the *baseline*, identical for every card of one wasm + runtime build) and
 *   zstd-compresses the result; a typical card is ~10–20 KB. {@link CardEngine.restore} reverses that. A snapshot
 *   whose baseline fingerprint differs from the running build cannot be restored, so the card is re-run from its
 *   stored bundle instead and starts from its initial state.
 * - **Bounds.** `memoryLimit` caps the heap; an interrupt handler caps every entry into the VM at `cpuMs`.
 * - **Host bridge.** The runtime calls `__host(op, payload)`; the engine forwards those to the {@link CardVmHost} the
 *   owner provides. A host callback must not re-enter the VM. `fetch` is the one request whose answer arrives later:
 *   the host accepts it (`{ ok: true, id }`) and settles it afterwards through {@link CardVm.settleFetch}, which
 *   resolves the promise inside the VM and drains its microtasks.
 *
 * @module dsh-im-card/engine
 */
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { QuickJS, type JSValueHandle } from 'quickjs-wasi'
import type { CardBundle } from './bundle.ts'
import type { CardPlatform } from './platform.ts'

/** One node of a rendered card tree, as the runtime emits it. */
export interface CardNode {
  t: string
  a: Record<string, unknown>
  c: CardNode[]
}

/** One file operation a card asked for, inside its data folder. */
export interface CardFilesRequest {
  /** What to do. */
  op: 'read' | 'write' | 'append' | 'remove' | 'stat' | 'list'
  /** Path relative to the card's data folder. */
  path: string
  /** Text of a `write` or `append`. */
  text?: string
}

/** The result of one file operation: its value (`undefined` for a write, and for a read of an absent file), or why it was refused. */
export type CardFilesReply = { ok: true; value?: unknown } | { ok: false; error: string }

/** One HTTP request a card sent; the host resolves it later through {@link CardVm.settleFetch}. */
export interface CardFetchRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

/** Whether the request was accepted (and under which id it settles), or why it was refused outright. */
export type CardFetchReply = { ok: true; id: string } | { ok: false; error: string }

/** The settled form of one request, handed back into the VM. */
export type CardFetchResult =
  | { ok: true; url: string; status: number; statusText: string; headers: Record<string, string>; body: string }
  | { ok: false; error: string }

/** What the VM asks of its owner. Every method is called synchronously from inside the VM; none may re-enter it. */
export interface CardVmHost {
  /** State changed outside a render: a render is due. */
  schedule(): void
  /** The timer table changed; `due` is the earliest due time (epoch ms) or -1. */
  timers(due: number): void
  /** Show a toast to the person whose click is being handled (no-op outside a click). */
  toast(content: string, type: string): void
  /** Send a message to the agent that owns the card. */
  agent(text: string): { ok: boolean; error?: string }
  /** One file operation inside the card's data folder. */
  files(request: CardFilesRequest): CardFilesReply
  /** Start one HTTP request; the owner settles it later with {@link CardVm.settleFetch}. */
  fetch(request: CardFetchRequest): CardFetchReply
  /** Run one synchronous host action invoked by a preset component. */
  action?(name: string, payload: unknown): unknown
  /** The card asked to be frozen. */
  close(): void
  /** console output. */
  log(level: string, text: string): void
  /** An uncaught error from a handler, an effect or a timer. */
  error(text: string): void
}

/** Bounds of one VM. */
export interface CardVmLimits {
  /** Heap bytes the VM may allocate. */
  memoryBytes: number
  /** CPU milliseconds one entry into the VM (mount, render, click, timers) may take. */
  cpuMs: number
}

/**
 * What a card knows about its audience, fixed when it starts (part of the VM memory, so a restore keeps it).
 */
export interface CardContext {
  /** The person whose message the card answers: the default owner of its quick replies. */
  requester?: { id: string; name?: string }
  /** What the chat platform can do with the card (`useCard().platform`); absent means every capability. */
  platform?: CardPlatform
}

/** A stored snapshot: compressed XOR delta of the VM memory plus the restore metadata. */
export interface CardSnapshot {
  /** Fingerprint of the baseline the delta was taken against. */
  baseline: string
  /** Memory length in bytes. */
  length: number
  /** zstd(memory XOR baseline), base64. */
  delta: string
  /** `Snapshot.stackPointer`, `runtimePtr`, `contextPtr`. */
  stackPointer: number
  runtimePtr: number
  contextPtr: number
}

const require = createRequire(import.meta.url)

/**
 * The runtime script the VM evaluates.
 *
 * The published layout is `dist/engine.js` next to `dist/vm/runtime.js`. Running from source — the tests import
 * `src/engine.ts` directly — there is no `src/vm/runtime.js`: the runtime is the TypeScript project in `src/vm/` and
 * only exists as a bundle, so the build output is used. Both are written by `scripts/build-vm.mjs`.
 * @throws Error naming the build when neither exists.
 */
function runtimeSource(): string {
  for (const candidate of ['./vm/runtime.js', '../dist/vm/runtime.js']) {
    const url = new URL(candidate, import.meta.url)
    if (existsSync(url)) return readFileSync(url, 'utf8')
  }
  throw new Error('the card VM runtime is not built: run `node scripts/build-vm.mjs` (or `pnpm run build`) first')
}

const RUNTIME_SOURCE = runtimeSource()

/** Result of one render. */
export type RenderOutcome = { ok: true; tree: CardNode[] } | { ok: false; error: string }

/**
 * The engine shared by every card of one process: the compiled wasm module and the baseline memory.
 */
export class CardEngine {
  private readonly wasm: WebAssembly.Module
  private readonly baselineMemory: Uint8Array
  /** Fingerprint of the wasm build and the runtime source. */
  readonly fingerprint: string
  private readonly limits: CardVmLimits

  private constructor(wasm: WebAssembly.Module, baselineMemory: Uint8Array, fingerprint: string, limits: CardVmLimits) {
    this.wasm = wasm
    this.baselineMemory = baselineMemory
    this.fingerprint = fingerprint
    this.limits = limits
  }

  /**
   * Load the wasm build, run the runtime once in a pristine VM and keep its memory as the snapshot baseline.
   * @param limits - VM bounds.
   * @returns the engine.
   */
  static async create(limits: CardVmLimits): Promise<CardEngine> {
    const bytes = readFileSync(require.resolve('quickjs-wasi/quickjs.wasm'))
    const wasm = new WebAssembly.Module(bytes)
    const fingerprint = createHash('sha256').update(bytes).update(RUNTIME_SOURCE).digest('hex').slice(0, 24)
    const vm = await QuickJS.create({ wasm, timezoneOffset: -480, memoryLimit: limits.memoryBytes })
    try {
      vm.newFunction('__host', () => vm.newString(''))
        .consume(fn => { vm.setProp(vm.global, '__host', fn) })
      vm.evalCode(RUNTIME_SOURCE, 'runtime.js').dispose()
      const memory = new Uint8Array(vm.snapshot().memory)
      return new CardEngine(wasm, memory, fingerprint, limits)
    } finally {
      vm.dispose()
    }
  }

  /**
   * Start a card from its bundle: evaluate the runtime and the entry module, mount the default export.
   * @param bundle - compiled modules.
   * @param props - JSON props of the root component.
   * @param host - the owner's bridge.
   * @param context - what the card knows about its audience (see {@link CardContext}).
   * @returns the live VM, mounted but not rendered.
   * @throws Error with a model-readable message when the module fails to evaluate or exports no component.
   */
  async start(bundle: CardBundle, props: unknown, host: CardVmHost, context: CardContext = {}): Promise<CardVm> {
    const card = new CardVm(host, this.limits.cpuMs)
    const vm = await QuickJS.create({
      wasm: this.wasm,
      timezoneOffset: -480,
      memoryLimit: this.limits.memoryBytes,
      interruptHandler: () => card.interrupted(),
    })
    card.attach(vm, true)
    try {
      card.enter(() => { vm.evalCode(RUNTIME_SOURCE, 'runtime.js').dispose() })
      card.setContext(context)
      if (!bundle.script) throw new Error('card module failed: this card was built by an older version and cannot restart; publish it again')
      card.evalScript(bundle.script, bundle.entry, JSON.stringify(props ?? {}))
      return card
    } catch (error) {
      vm.dispose()
      throw error
    }
  }

  /**
   * Restore a card from a snapshot.
   * @param snapshot - the stored snapshot.
   * @param host - the owner's bridge.
   * @returns the live VM, or `undefined` when the snapshot was taken against another baseline.
   */
  async restore(snapshot: CardSnapshot, host: CardVmHost): Promise<CardVm | undefined> {
    if (snapshot.baseline !== this.fingerprint) return undefined
    const delta = new Uint8Array(zstdDecompressSync(Buffer.from(snapshot.delta, 'base64')))
    if (delta.length !== snapshot.length) throw new Error('card snapshot is corrupt (length mismatch)')
    const base = this.baselineMemory
    const memory = new Uint8Array(snapshot.length)
    for (let i = 0; i < memory.length; i++) memory[i] = delta[i]! ^ (i < base.length ? base[i]! : 0)
    const card = new CardVm(host, this.limits.cpuMs)
    const vm = await QuickJS.restore({
      memory,
      stackPointer: snapshot.stackPointer,
      runtimePtr: snapshot.runtimePtr,
      contextPtr: snapshot.contextPtr,
      extensions: [],
    }, {
      wasm: this.wasm,
      timezoneOffset: -480,
      memoryLimit: this.limits.memoryBytes,
      interruptHandler: () => card.interrupted(),
    })
    card.attach(vm, false)
    return card
  }

  /**
   * Snapshot a live VM.
   * @param card - the VM.
   * @returns the stored form.
   */
  snapshot(card: CardVm): CardSnapshot {
    const snap = card.raw().snapshot()
    const memory = new Uint8Array(snap.memory)
    const base = this.baselineMemory
    const delta = new Uint8Array(memory.length)
    for (let i = 0; i < memory.length; i++) delta[i] = memory[i]! ^ (i < base.length ? base[i]! : 0)
    const packed = zstdCompressSync(delta, { params: { [constants.ZSTD_c_compressionLevel]: 3 } })
    return {
      baseline: this.fingerprint,
      length: memory.length,
      delta: packed.toString('base64'),
      stackPointer: snap.stackPointer,
      runtimePtr: snap.runtimePtr,
      contextPtr: snap.contextPtr,
    }
  }
}

/** One live card VM. Not reentrant: callers serialize every entry. */
export class CardVm {
  private vm: QuickJS | undefined
  private deadline = 0
  private host: CardVmHost
  private readonly cpuMs: number

  constructor(host: CardVmHost, cpuMs: number) {
    this.host = host
    this.cpuMs = cpuMs
  }

  /** @internal */
  attach(vm: QuickJS, fresh: boolean): void {
    this.vm = vm
    const fn = (...args: JSValueHandle[]): JSValueHandle => this.dispatch(args)
    // A restored VM already holds the `__host` function object; only its host callback is re-registered by name.
    if (fresh) vm.newFunction('__host', fn).consume((handle) => { vm.setProp(vm.global, '__host', handle) })
    else vm.registerHostCallback('__host', fn)
  }

  /** @internal */
  interrupted(): boolean {
    return this.deadline !== 0 && Date.now() > this.deadline
  }

  /** @internal */
  raw(): QuickJS {
    if (this.vm === undefined) throw new Error('card VM is disposed')
    return this.vm
  }

  /**
   * Swap the bridge (a restored VM is attached before its owner exists).
   * @param host - the new bridge.
   */
  rebind(host: CardVmHost): void {
    this.host = host
  }

  private dispatch(args: JSValueHandle[]): JSValueHandle {
    const vm = this.raw()
    const op = args[0]?.toString() ?? ''
    const payload = args[1]?.toString() ?? ''
    let reply = ''
    try {
      switch (op) {
        case 'schedule': this.host.schedule(); break
        case 'timers': this.host.timers(Number(payload)); break
        case 'toast': {
          const parsed = JSON.parse(payload) as { content?: unknown; type?: unknown }
          this.host.toast(String(parsed.content ?? ''), typeof parsed.type === 'string' ? parsed.type : 'info')
          break
        }
        case 'agent': reply = JSON.stringify(this.host.agent(payload)); break
        case 'fs': {
          const parsed = parse<CardFilesRequest>(payload)
          reply = JSON.stringify(typeof parsed === 'string' ? { ok: false, error: parsed } : this.host.files(parsed))
          break
        }
        case 'fetch': {
          const parsed = parse<CardFetchRequest>(payload)
          reply = JSON.stringify(typeof parsed === 'string' ? { ok: false, error: parsed } : this.host.fetch(parsed))
          break
        }
        case 'action': {
          const parsed = parse<{ name?: unknown; payload?: unknown }>(payload)
          if (typeof parsed === 'string' || typeof parsed.name !== 'string') {
            reply = JSON.stringify({ ok: false, error: typeof parsed === 'string' ? parsed : 'missing action name' })
          } else if (this.host.action === undefined) {
            reply = JSON.stringify({ ok: false, error: `no handler for action ${parsed.name}` })
          } else {
            try {
              reply = JSON.stringify(this.host.action(parsed.name, parsed.payload) ?? { ok: true })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              this.host.error(`host action ${parsed.name} failed: ${message}`)
              reply = JSON.stringify({ ok: false, error: message })
            }
          }
          break
        }
        case 'close': this.host.close(); break
        case 'log': {
          const parsed = JSON.parse(payload) as { level?: unknown; text?: unknown }
          this.host.log(String(parsed.level ?? 'log'), String(parsed.text ?? ''))
          break
        }
        case 'error': this.host.error(payload); break
        default: break
      }
    } catch (error) {
      // A failing owner callback must not unwind through the VM; it is reported as a card error instead.
      this.host.error(`host ${op} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return vm.newString(reply)
  }

  /** @internal Run one synchronous entry under the CPU deadline, then drain microtasks. */
  enter<T>(fn: () => T): T {
    // A nested entry (a host callback that calls back into the VM) keeps the outer deadline.
    const outer = this.deadline
    if (outer === 0) this.deadline = Date.now() + this.cpuMs
    try {
      const result = fn()
      this.raw().executePendingJobs()
      return result
    } finally {
      this.deadline = outer
    }
  }

  /** @internal Publish the host-provided context as the global the presets read. */
  setContext(context: CardContext): void {
    const json = JSON.stringify(context)
    this.enter(() => { this.raw().evalCode(`globalThis.__cardContext = ${json}`, 'card-context.js').dispose() })
  }

  /** @internal Evaluate the bundled script and mount the entry's default export. */
  evalScript(script: string, name: string, propsJson: string): void {
    const vm = this.raw()
    try {
      this.enter(() => { vm.evalCode(script, name).dispose() })
    } catch (error) {
      throw new Error(`card module failed: ${describe(vm, error)}`)
    }
    const kind = this.call('typeof globalThis.__cardDefault')
    if (kind === 'undefined') throw new Error('card module failed: no default export (export default a component)')
    this.call(`__card.mount(globalThis.__cardDefault, ${JSON.stringify(propsJson)}); delete globalThis.__cardDefault`)
  }

  private call(code: string): string {
    const vm = this.raw()
    return this.enter(() => {
      try {
        return vm.evalCode(code, 'host').consume(h => (h.isUndefined ? '' : h.toString()))
      } catch (error) {
        throw new Error(`card call failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  /**
   * Render the tree.
   * @returns the tree, or the render error.
   */
  render(): RenderOutcome {
    try {
      return JSON.parse(this.call('__card.render()')) as RenderOutcome
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Run the handler of one button token.
   * @param token - the button id.
   * @param event - the click as the handler sees it.
   * @returns whether a handler is registered under that token.
   */
  click(token: string, event: unknown): boolean {
    const reply = this.call(`__card.click(${JSON.stringify(token)}, ${JSON.stringify(JSON.stringify(event))})`)
    return (JSON.parse(reply) as { found: boolean }).found
  }

  /**
   * Fire every timer due by `now`.
   * @param now - epoch ms.
   */
  fireTimers(now: number): void {
    this.call(`__card.fireTimers(${now})`)
  }

  /**
   * Hand one settled request to the VM, resolving or rejecting the promise the card waits on.
   * @param id - request id the card was given.
   * @param result - the response, or the failure.
   * @returns whether the card still waited for that request (it may have been frozen or restarted since).
   */
  settleFetch(id: string, result: CardFetchResult): boolean {
    const reply = this.call(`__card.settleFetch(${JSON.stringify(id)}, ${JSON.stringify(JSON.stringify(result))})`)
    return (JSON.parse(reply) as { found: boolean }).found
  }

  /**
   * Push one host-originated event to subscribed preset components in the VM.
   * @param channel - channel name (e.g. `'auth'`).
   * @param data - JSON-serializable payload.
   * @returns whether any listener inside the VM handled the event.
   */
  pushEvent(channel: string, data: unknown): boolean {
    const reply = this.call(`__card.pushEvent(${JSON.stringify(channel)}, ${JSON.stringify(JSON.stringify(data))})`)
    return (JSON.parse(reply) as { handled: boolean }).handled
  }

  /**
   * The earliest due timer.
   * @returns epoch ms, or -1 when no timer is set.
   */
  nextTimer(): number {
    return Number(this.call('__card.nextTimer()'))
  }

  /** Collect garbage so the next snapshot carries less. */
  gc(): void {
    this.raw().runGC()
  }

  /** Free the VM. */
  dispose(): void {
    const vm = this.vm
    this.vm = undefined
    vm?.dispose()
  }
}

/**
 * One bridge payload as the request it carries.
 * @param payload - the JSON text the VM sent.
 * @returns the request, or the reason the payload is unusable.
 */
function parse<T>(payload: string): T | string {
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    return `not JSON: ${payload.slice(0, 120)}`
  }
  return value !== null && typeof value === 'object' ? value as T : `not a request: ${payload.slice(0, 120)}`
}

/** A thrown QuickJS exception (or host error) as `message\nstack`. */
function describe(vm: QuickJS, error: unknown): string {
  const handle = (error as { handle?: JSValueHandle }).handle
  if (handle !== undefined) {
    try {
      return errorText(vm, handle)
    } finally {
      (error as { dispose?: () => void }).dispose?.()
    }
  }
  return error instanceof Error ? error.message : String(error)
}

function errorText(vm: QuickJS, handle: JSValueHandle): string {
  try {
    const message = handle.getProp('message').consume(h => (h.isUndefined ? '' : h.toString()))
    const stack = handle.getProp('stack').consume(h => (h.isUndefined ? '' : h.toString()))
    return [message || String(vm.dump(handle)), stack].filter(Boolean).join('\n')
  } catch {
    // Not an Error object: its plain dump is the best description available.
    return String(vm.dump(handle))
  }
}
