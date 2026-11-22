/**
 * What the chat platform of a card can do with it, probed from the adapter instead of assumed.
 *
 * A card is written once, in the platform-neutral element vocabulary, and the adapter renders it: Lark draws a card
 * whose message is edited in place and whose clicks are answered with a toast; QQ draws markdown with a custom
 * keyboard, cannot edit a published message, answers no click, and has no form controls. The card service and the
 * preset components adapt to the difference through {@link CardPlatform}:
 *
 * - `edit`: the adapter edits published messages (`Adapter.editPayload`). Without it a card is republished by
 *   recalling the old message and answering the click with a new one.
 * - `buttons`: an action button renders as something a person can click — a dry render of one button reports no
 *   `INTERACTION_DROPPED`. Without it a card reads as text and the presets name what to reply instead.
 * - `forms`: `<form>`, `<input>` and `<select>` render natively. Without them the form preset collects its fields with
 *   buttons.
 * - `toast`: clicks can be answered with a toast (`ButtonEvent.respond`). Learned from the clicks themselves; until one
 *   arrived it follows `edit`, because the platforms that edit cards are the ones that answer their callbacks.
 *
 * @module dsh-im-card/platform
 */
import {
  directive, EXPRESSIVE_DIRECTIVE, h, INTERACTION_DROPPED, type Bot, type RenderReport, type Target,
} from '@deepseek-ai/cordis-plugin-im-core'

/** What one chat platform can do with a card. */
export interface CardPlatform {
  /** Platform name of the bot (`lark`, `feishu`, `qq` …). */
  name: string
  /** Published messages can be edited in place. */
  edit: boolean
  /** Action buttons are clickable. */
  buttons: boolean
  /** `<form>`, `<input>` and `<select>` render as native controls. */
  forms: boolean
  /** A click can be answered with a toast. */
  toast: boolean
}

/** The capabilities assumed when nothing can be probed (a bot without `render`): everything a card may use. */
export const FULL_PLATFORM: CardPlatform = { name: 'unknown', edit: true, buttons: true, forms: true, toast: true }

/** Whether a dry render lost an interaction or a tag. */
function lost(report: RenderReport | undefined, tags: readonly string[]): boolean {
  if (report === undefined) return false
  if (report.dropped.some(entry => entry.reason === INTERACTION_DROPPED)) return true
  return report.degraded.some(entry => tags.includes(entry.tag) && !entry.path.includes('>'))
}

/**
 * Whether a bot implements in-place edits at all. The core keeps this private (`Bot.canEdit`); the hook it checks is
 * the adapter's public `editPayload`.
 * @param bot - the bot that publishes the card.
 */
export function botEdits(bot: Bot): boolean {
  return typeof (bot as unknown as { editPayload?: unknown }).editPayload === 'function'
}

/**
 * Probe what a bot can do with a card in one chat, by dry-rendering one button and one form in the mode a card is
 * published in (`prefer-expressive-mode`).
 * @param bot - the bot that publishes the card.
 * @param target - the chat it publishes into.
 * @returns the capabilities; a probe that cannot run assumes the capability.
 */
export async function probePlatform(bot: Bot, target: Target): Promise<CardPlatform> {
  const render = async (...content: ReturnType<typeof h>[]): Promise<RenderReport | undefined> => {
    if (typeof bot.render !== 'function') return undefined
    try {
      return (await bot.render(target, h('message', directive(EXPRESSIVE_DIRECTIVE), ...content))).report
    } catch {
      // A probe the adapter refuses tells nothing about the capability; the card itself is checked before it is sent.
      return undefined
    }
  }
  const make = h as unknown as (tag: string, attrs: Record<string, unknown>, ...kids: unknown[]) => ReturnType<typeof h>
  const button = await render(make('button', { type: 'action', id: 'dsh:card:probe:0' }, 'ok'))
  const form = await render(make('form', { name: 'probe' },
    make('input', { name: 'text' }),
    make('select', { name: 'pick' }, make('option', { value: 'a' }, 'a')),
    make('button', { type: 'submit', id: 'dsh:card:probe:1' }, 'ok')))
  const edit = botEdits(bot)
  return {
    name: bot.platform ?? 'unknown',
    edit,
    buttons: !lost(button, ['button']),
    forms: !lost(form, ['form', 'input', 'select']),
    toast: edit,
  }
}

/**
 * What the model should know about a platform's limits when it publishes there, one sentence per limit.
 * @param platform - the probed capabilities.
 * @returns the notes, empty for a platform with every capability.
 */
export function platformNotes(platform: CardPlatform): string[] {
  const notes: string[] = []
  if (!platform.edit) {
    notes.push('This platform cannot edit a sent message: each click that changes the card recalls the old message '
      + 'and answers the click with a new one (at most a few per 5 minutes); timers and fetch results never refresh '
      + 'it on their own, only the next click shows them.')
  }
  if (!platform.buttons) {
    notes.push('Buttons are not clickable here (they are shown as text); readers answer by replying in the chat.')
  } else if (!platform.forms) {
    notes.push('Form controls (<form>, <input>, <select>) do not render here; <PromptForm> collects its fields with '
      + 'buttons and asks for free text as a chat reply. Keyboard buttons: at most 5 rows of 5, labels of at most 10 '
      + 'characters.')
  }
  if (!platform.toast) notes.push('Clicks cannot be answered with a toast here; card.toast() is ignored.')
  return notes
}
