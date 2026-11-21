/**
 * The interactive-card VM runtime: the whole in-VM API, installed as globals for the card module that runs next.
 *
 * This directory is a small TypeScript project of its own, built into **one plain script** that the engine evaluates
 * inside a QuickJS VM (`scripts/vm-build.mjs` → `dist/vm/runtime.js`). It has its own `tsconfig.json` with `lib:
 * ES2023` and no Node types on purpose: nothing here may reach for a host API, because inside the VM there is none —
 * `globalThis.__host` is the only way out, and the engine installs it before this script runs.
 *
 * | module | what it owns |
 * | --- | --- |
 * | `globals.ts` | the VM global object, typed; `setGlobal` for the names a card sees |
 * | `host.ts` | the `__host` bridge, `console`, `queueMicrotask`, error reporting |
 * | `timers.ts` | the timer table the host wakes the VM for |
 * | `jsx.ts` | vnodes, `__jsx__` / `__h__` / `__fragment__` |
 * | `context.ts` | the render model (instances, hooks, passes) both halves of the renderer share |
 * | `hooks.ts` | `useState`, `useReducer`, `useEffect`, `useMemo`, `useCallback`, `useRef`, `useId` |
 * | `render.ts` | the walk from vnode to card nodes, interaction tokens, `mount` / `render` / `click` / `unmount` |
 * | `actions.ts` | `agent.send`, `useCard()` (`toast`, `close`, `send`) |
 * | `files.ts` | `fs` (the card's data folder) and `useStoredState` |
 * | `http.ts` | `fetch`, settled later by the host |
 * | `presets/` | the six quick-reply components, written in TSX |
 *
 * Host protocol (see `src/engine.ts` for the other side):
 *
 *   host → runtime: `__host(op, payload)`, strings in, string out. Ops: `schedule`, `timers`, `toast`, `agent`,
 *   `fs`, `fetch`, `close`, `log`, `error`.
 *   runtime → host: `__card.mount/render/click/nextTimer/fireTimers/settleFetch/unmount`, `__jsx__`, `__fragment__`,
 *   `__h__`, `__cardApi`, plus the hooks, `agent`, `fs`, `fetch` and the presets as plain globals.
 *
 * @module dsh-im-card/vm
 */
import { agent, dispatchHostEvent, useCard } from './actions.ts'
import { cardFs, useStoredState } from './files.ts'
import { g, setGlobal } from './globals.ts'
import { installConsole, installMicrotask } from './host.ts'
import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from './hooks.ts'
import { requestCard, settleFetch } from './http.ts'
import { Fragment, installJsx } from './jsx.ts'
import { AuthRequest } from './presets/auth.tsx'
import { Segmented, Stepper, Switch } from './presets/controls.tsx'
import { PromptForm } from './presets/form.tsx'
import { PromptButton, PromptChoices } from './presets/quick-reply.tsx'
import { click, mount, render, unmount } from './render.ts'
import { fireTimers, installTimers, nextTimerDue } from './timers.ts'

installConsole()
installMicrotask()
installTimers()
installJsx()

/**
 * The hook API. The order is the order of `Object.keys(__cardApi)`, which `test/runtime.test.ts` pins — a card may
 * destructure `dsh:card`, so the set and its order are part of the contract.
 */
const hooks = {
  useState,
  useReducer,
  useEffect,
  useLayoutEffect: useEffect,
  useMemo,
  useCallback,
  useRef,
  useId,
  useCard,
  useStoredState,
}

/** The prebuilt preset components: no import, no definition. */
const presets = { PromptButton, PromptChoices, PromptForm, Switch, Segmented, Stepper, AuthRequest }

for (const name of Object.keys(hooks)) setGlobal(name, (hooks as Record<string, unknown>)[name])
for (const name of Object.keys(presets)) setGlobal(name, (presets as Record<string, unknown>)[name])
setGlobal('agent', agent)
setGlobal('fs', cardFs)
setGlobal('fetch', requestCard)

g.__card = { mount, render, click, nextTimer: nextTimerDue, fireTimers, settleFetch, pushEvent: dispatchHostEvent, unmount }
g.__cardApi = Object.freeze({ ...hooks, Fragment, agent, fs: cardFs, fetch: requestCard, ...presets })
