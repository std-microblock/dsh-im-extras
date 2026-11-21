/**
 * The panel's data access and formatting. Every call is same-origin against the routes of `../protocol.ts`, which sit
 * on the harness's authenticated `/api` channel.
 *
 * @module dsh-im-panel/client/api
 */

import {
  CHRONICLE_PATH, PANEL_PATH, TAB_PATH, type ImPanelChroniclePage, type ImPanelCommand, type ImPanelQuery,
  type ImPanelResult, type ImPanelState,
} from '../protocol.ts'

/** A read or write the page could not complete. */
export class ApiError extends Error {}

function failureOf(text: string): string {
  try {
    const parsed = JSON.parse(text) as { text?: unknown }
    return typeof parsed.text === 'string' ? parsed.text : text
  } catch {
    return text
  }
}

/**
 * Read one JSON answer, keeping the API's own message on a failure.
 * @param response - the response to read.
 * @throws {ApiError} when the carrier refused the call or the body is not JSON.
 */
export async function bodyOf<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (!response.ok) {
    const described = text.trim()
    throw new ApiError(described === ''
      ? `请求失败（HTTP ${String(response.status)}）`
      : described.startsWith('{') ? failureOf(described) : `请求失败（HTTP ${String(response.status)}）：${described}`)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError('面板 API 没有返回 JSON：这个部署可能没有挂上 dsh-im-panel')
  }
}

/**
 * A query string.
 * @param query - values; `undefined` is dropped.
 */
export function queryString(query: ImPanelQuery | undefined): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(key, String(value))
  }
  const text = params.toString()
  return text === '' ? '' : `&${text}`
}

/** Read one snapshot. */
export async function readState(signal?: AbortSignal): Promise<ImPanelState> {
  return await bodyOf<ImPanelState>(await fetch(PANEL_PATH, { signal, headers: { accept: 'application/json' } }))
}

/** Run one built-in command. */
export async function send(command: ImPanelCommand): Promise<ImPanelResult> {
  return await bodyOf<ImPanelResult>(await fetch(PANEL_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(command),
  }))
}

/** Read one page of the chronicle. */
export async function readChronicle(query: ImPanelQuery, signal?: AbortSignal): Promise<ImPanelChroniclePage> {
  return await bodyOf<ImPanelChroniclePage>(await fetch(`${CHRONICLE_PATH}?${queryString(query).slice(1)}`, {
    signal, headers: { accept: 'application/json' },
  }))
}

/**
 * The URL of one extension tab's route.
 * @param id - the tab id.
 * @param path - the sub path.
 * @param query - extra parameters.
 */
export function tabUrl(id: string, path = '', query?: ImPanelQuery): string {
  return `${TAB_PATH}?id=${encodeURIComponent(id)}${path === '' ? '' : `&path=${encodeURIComponent(path)}`}${queryString(query)}`
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** A moment as the page writes it. */
export function formatTime(at: number, full = true): string {
  const date = new Date(at)
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return full ? `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${clock}` : clock
}

/** How long ago a moment was. */
export function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${String(Math.round(seconds / 60))} 分钟前`
  if (seconds < 86_400) return `${String(Math.round(seconds / 3600))} 小时前`
  return `${String(Math.round(seconds / 86_400))} 天前`
}

/** The message of a thrown value. */
export function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
