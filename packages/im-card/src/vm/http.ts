/**
 * `fetch` for cards.
 *
 * The bridge is synchronous, so a call only hands one request to the host; the promise settles later, when the host
 * calls `settleFetch` with the answer. A request whose answer never comes (the card was frozen meanwhile) stays
 * pending and is dropped with the VM. Every failure — refused, failed, unreadable reply — rejects the promise and is
 * also swallowed once, because a card may legitimately only read `.ok`.
 *
 * @module dsh-im-card/vm/http
 */
import { host, reportError } from './host.ts'

/** What to send with a request. */
export interface CardFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
}

/** A response, as a card reads it. */
export interface CardResponse {
  ok: boolean
  status: number
  statusText: string
  url: string
  headers: { get(name: string): string | undefined }
  text(): Promise<string>
  json<T = unknown>(): Promise<T>
}

/** What the host answers to a request: accepted under an id, or refused. */
interface FetchReply {
  ok?: unknown
  id?: unknown
  error?: unknown
}

/** One accepted request, waiting for its answer. */
interface PendingRequest {
  resolve(response: CardResponse): void
  reject(reason: Error): void
}

/** Requests the host accepted but has not answered yet, by the id the host gave them. */
const requests = new Map<string, PendingRequest>()

/**
 * Parse JSON, treating anything unreadable as absent.
 * @param text - the text to parse.
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * The answer of one request, shaped the way a card reads it.
 * @param reply - the object the host settled the request with.
 */
function responseOf(reply: Record<string, unknown>): CardResponse {
  const headers = reply.headers !== null && typeof reply.headers === 'object' ? (reply.headers as Record<string, unknown>) : {}
  const body = typeof reply.body === 'string' ? reply.body : ''
  const status = Number(reply.status)
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: typeof reply.statusText === 'string' ? reply.statusText : '',
    url: typeof reply.url === 'string' ? reply.url : '',
    headers: {
      get(name) {
        const wanted = String(name).toLowerCase()
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === wanted) return String(headers[key])
        }
        return undefined
      },
    },
    text() {
      return Promise.resolve(body)
    },
    json<T = unknown>() {
      try {
        return Promise.resolve(JSON.parse(body) as T)
      } catch {
        return Promise.reject(new Error('the response body is not JSON'))
      }
    },
  }
}

/**
 * Send one request (`fetch` as a global).
 * @param url - the URL; it is stringified.
 * @param init - method, headers and body.
 * @returns the response once the host settles it; rejects with the reason when it is refused or fails.
 */
export function requestCard(url: unknown, init?: CardFetchInit | null): Promise<CardResponse> {
  const options = init === undefined || init === null ? {} : init
  const request: CardFetchInit & { url: string } = { url: String(url) }
  if (options.method !== undefined) request.method = String(options.method)
  if (options.headers !== undefined && options.headers !== null) request.headers = options.headers
  if (options.body !== undefined && options.body !== null) request.body = String(options.body)
  const reply = parseJson(host('fetch', JSON.stringify(request))) as FetchReply | null
  if (reply === null || reply.ok !== true || typeof reply.id !== 'string') {
    const reason = reply !== null && typeof reply.error === 'string' ? reply.error : 'the request was refused'
    const refused = Promise.reject(new Error(reason))
    refused.then(undefined, function () {})
    return refused
  }
  const promise = new Promise<CardResponse>(function (resolve, reject) {
    requests.set(reply.id as string, { resolve, reject })
  })
  promise.then(undefined, function () {})
  return promise
}

/**
 * Settle one request inside the VM.
 * @param id - the id the host accepted the request under.
 * @param replyJson - `{ ok: true, status, … }` or `{ ok: false, error }`, as JSON.
 * @returns `{ found }`, as JSON: `false` when nothing was waiting on that id.
 */
export function settleFetch(id: string, replyJson: string): string {
  const key = String(id)
  const entry = requests.get(key)
  if (entry === undefined) return JSON.stringify({ found: false })
  requests.delete(key)
  const reply = parseJson(replyJson)
  try {
    if (reply !== null && (reply as FetchReply).ok === true) entry.resolve(responseOf(reply as Record<string, unknown>))
    else {
      const answer = reply as FetchReply | null
      entry.reject(new Error(answer !== null && typeof answer.error === 'string' ? answer.error : 'the request failed'))
    }
  } catch (e) {
    reportError(e)
  }
  return JSON.stringify({ found: true })
}

/**
 * Drop every request still waiting (the card is gone, so nobody will read the answers).
 * @param reason - the rejection reason the waiting promises see.
 */
export function rejectPendingRequests(reason: string): void {
  for (const entry of requests.values()) entry.reject(new Error(reason))
  requests.clear()
}
