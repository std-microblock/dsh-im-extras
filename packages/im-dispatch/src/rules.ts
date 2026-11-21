/**
 * Route-rule evaluation (port of the v3 `RuleEngine`): each rule is one JavaScript expression over the message fields
 * `im`, evaluated in a fresh QuickJS context of a WebAssembly runtime with a memory, stack and time bound. Nothing of
 * the host is reachable from a rule.
 *
 * @module dsh-im-dispatch/rules
 */

import { shouldInterruptAfterDeadline, type QuickJSWASMModule } from '@tootallnate/quickjs-emscripten'
import type { ElementLike, ImStoredMessage } from './types.ts'
import { splitKey } from './im.ts'

/** The fields one rule reads as `im`; an absent platform field is `null`. */
export interface RuleInput {
  /** Platform message ID. */
  id: string
  /** Configured IM source that admitted the message. */
  source: string
  chat: {
    id: string
    /** Whether the chat is one-to-one with the bot. */
    direct: boolean
  }
  sender: {
    /** Platform user ID (open_id); empty for an anonymous sender. */
    id: string
    /** `user` or `bot`. */
    type: string
  }
  /** Whether the message addresses the bot: arrived in a one-to-one chat, mentions the bot, or replies to the bot. */
  at_me: boolean
  /** Platform user IDs the message mentions. */
  mentions: string[]
  /** Message text, with references for media and other non-text content. */
  content: string
  /** Message kind: `text`, `post`, `image`, `audio`, `video`, `file`, `merge_forward`, or a raw platform type. */
  type: string
  /** Creation time in milliseconds since the epoch. */
  time: number
  thread_id: string | null
  root_id: string | null
  parent_id: string | null
  /** Images and files the message carries. */
  resources: { type: string; name: string | null }[]
}

/** Model-facing reference of the fields a rule reads. */
export const RULE_FIELDS = 'A rule is one JavaScript expression over the object im; a truthy result matches. '
  + 'im has: id (message ID), source, chat.id, chat.direct (one-to-one chat with the bot), sender.id (open_id), sender.type, '
  + 'at_me (one-to-one chat, mentions the bot, or replies to the bot), mentions (open_ids), content (message text), '
  + 'type (text, post, image, audio, video, file, merge_forward, ...), time (milliseconds since the epoch), thread_id, root_id, parent_id (null when absent), '
  + 'and resources ([{type, name}]). Sender display names are not available. '
  + 'Example: im.sender.id === \'ou_x\' && im.content.includes(\'deploy\') && !im.at_me'

/** Resource bounds of rule evaluation. */
export interface RuleLimits {
  /** Wall-clock budget of one rule against one message, in milliseconds. */
  timeoutMs: number
  /** Heap limit of the runtime that evaluates the rules of one message, in bytes. */
  memoryBytes: number
}

/** Outcome of one rule against one message. */
export type RuleOutcome = { matched: boolean; error?: undefined } | { matched: false; error: string }

/** Media tags and the rule `type` they report. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  img: 'image',
  audio: 'audio',
  video: 'video',
  file: 'file',
}

/** Wrap one rule expression; an expression that is not complete JavaScript fails to compile. */
function wrap(expression: string): string {
  return `'use strict';\n!!(\n${expression}\n)`
}

/** Deep-freeze the message fields so one rule's expression cannot change them for itself. */
function prelude(input: RuleInput): string {
  return '\'use strict\'; globalThis.im = (function freeze(value) { Object.freeze(value); '
    + 'for (const key of Object.keys(value)) if (value[key] !== null && typeof value[key] === \'object\') freeze(value[key]); '
    + `return value })(${JSON.stringify(input)});`
}

/** Text of a thrown guest value. */
function describe(value: unknown): string {
  if (value !== null && typeof value === 'object' && 'message' in value) {
    const named = value as { name?: unknown; message?: unknown }
    return `${typeof named.name === 'string' ? named.name : 'Error'}: ${String(named.message)}`
  }
  return String(value)
}

/** Every media element of one message, with the rule type it reports, outermost first. */
function mediaOf(element: ElementLike, found: { type: string; element: ElementLike }[] = []): { type: string; element: ElementLike }[] {
  for (const child of element.children) {
    const type = MEDIA_TYPES[child.type]
    if (type !== undefined) found.push({ type, element: child })
    mediaOf(child, found)
  }
  return found
}

/**
 * The message kind a rule sees. The v3 rule fields were built from a platform message; the v4 message is normalized
 * elements, so the kind is derived: a forwarded message is `merge_forward`, an inbound platform payload keeps its raw
 * type, a message carrying media is that media kind, and a text message with several blocks is `post`.
 * @param content - normalized message content (`<message>` root).
 * @returns the rule `type`.
 */
export function messageType(content: ElementLike): string {
  for (const child of content.children) {
    if (child.type === 'forward') return 'merge_forward'
    if (child.type === 'raw') return String(child.attrs.type)
    const media = MEDIA_TYPES[child.type]
    if (media !== undefined) return media
  }
  const blocks = content.children.filter(child => child.type !== 'quote' && child.type !== 'title').length
  return blocks > 1 ? 'post' : 'text'
}

/**
 * The fields one stored message exposes to a rule.
 * @param message - the admitted message.
 * @param addressed - resolved addressing status (falls back to `message.addressed`).
 * @returns the rule input.
 */
export function ruleInput(message: ImStoredMessage, addressed = message.addressed): RuleInput {
  return {
    id: splitKey(message.key).id,
    source: message.chat.source,
    chat: { id: splitKey(message.chat.key).id, direct: message.chat.ref.type === 'direct' },
    sender: { id: message.sender.id, type: message.sender.isBot === true ? 'bot' : 'user' },
    at_me: addressed,
    mentions: message.mentions.users.map(user => user.id),
    content: message.text,
    type: messageType(message.content),
    time: message.time,
    thread_id: message.thread?.id ?? null,
    root_id: message.thread?.root ?? null,
    parent_id: message.quote === undefined ? null : splitKey(message.quote.key).id,
    resources: mediaOf(message.content).map(({ type, element }) => {
      const name = element.attrs.name ?? element.attrs.alt
      return { type, name: typeof name === 'string' ? name : null }
    }),
  }
}

/** Evaluates route rules in QuickJS. */
export class RuleEngine {
  private readonly module: QuickJSWASMModule
  private readonly limits: RuleLimits

  /**
   * @param module - owned QuickJS WebAssembly module.
   * @param limits - bounds of every evaluation.
   */
  constructor(module: QuickJSWASMModule, limits: RuleLimits) {
    this.module = module
    this.limits = limits
  }

  /**
   * Compile one rule expression without running it.
   * @param expression - the rule.
   * @returns the compile error, or undefined when the expression compiles.
   */
  check(expression: string): string | undefined {
    const runtime = this.runtime()
    const vm = runtime.newContext()
    try {
      const result = vm.evalCode(wrap(expression), 'rule.js', { compileOnly: true })
      if (result.error) {
        const error = describe(vm.dump(result.error))
        result.error.dispose()
        return error
      }
      result.value.dispose()
      return undefined
    } finally {
      vm.dispose()
      runtime.dispose()
    }
  }

  /**
   * Evaluate rules against one message, each in its own context, so one rule cannot change the globals another rule
   * reads. A rule that throws, exceeds its time, or exhausts memory does not match and reports its error.
   * @param expressions - rule expressions keyed by rule ID.
   * @param input - the message fields.
   * @returns the outcome of each rule.
   */
  evaluate(expressions: ReadonlyMap<number, string>, input: RuleInput): Map<number, RuleOutcome> {
    const outcomes = new Map<number, RuleOutcome>()
    if (!expressions.size) return outcomes
    const runtime = this.runtime()
    const setup = prelude(input)
    try {
      for (const [id, expression] of expressions) {
        runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + this.limits.timeoutMs))
        const vm = runtime.newContext()
        try {
          const result = vm.evalCode(`${setup}\n!!(\n${expression}\n)`, 'rule.js')
          if (result.error) {
            outcomes.set(id, { matched: false, error: describe(vm.dump(result.error)) })
            result.error.dispose()
          } else {
            outcomes.set(id, { matched: vm.dump(result.value) === true })
            result.value.dispose()
          }
        } finally {
          vm.dispose()
        }
      }
    } finally {
      runtime.dispose()
    }
    return outcomes
  }

  private runtime() {
    const runtime = this.module.newRuntime()
    runtime.setMemoryLimit(this.limits.memoryBytes)
    return runtime
  }
}
