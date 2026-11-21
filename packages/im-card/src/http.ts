/**
 * `fetch` for a card: one HTTP(S) request, bounded and settled by the host.
 *
 * A card's request is a normal HTTP request except for the choices this module makes on the operator's behalf:
 *
 * - **Any host?** `hosts` restricts the reachable host names (`api.example.com`, `*.internal`); empty means any host.
 * - **Private addresses.** Unless `allowPrivate` is set, a target that resolves to a loopback, private, link-local or
 *   carrier-grade NAT address is refused, so a card cannot reach the bot's own network services by name. Redirects are
 *   followed one hop at a time and every hop is checked again (`redirect: 'manual'`), so a public URL cannot bounce a
 *   card into an internal one.
 * - **Bounds.** One whole request budget (`timeoutMs`, redirects included) and one response cap (`maxBytes`); the body
 *   is read as text, because the VM receives the settled response in one piece.
 *
 * @module dsh-im-card/http
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { CardFetchRequest, CardFetchResult } from './engine.ts'

/** How far one card request may go. */
export interface FetchLimits {
  /** Budget of one request, redirects included. */
  timeoutMs: number
  /** Largest response body the card receives. */
  maxBytes: number
  /** Host names a card may reach (a `*` matches any span); empty allows any host. */
  hosts: string[]
  /** Allow loopback, private, link-local and carrier-grade NAT addresses. */
  allowPrivate: boolean
  /** Aborts the request when the owning card goes away. */
  signal?: AbortSignal
}

/** Redirects one request may follow. */
const MAX_REDIRECTS = 3

/** Header names a card may set (`token` in RFC 9110 terms). */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/**
 * Perform one card request.
 * @param request - URL, method, headers and body as the card sent them.
 * @param limits - reachability and size rules of this deployment.
 * @returns the response, or the reason the request did not happen or failed.
 */
export async function cardFetch(request: CardFetchRequest, limits: FetchLimits): Promise<CardFetchResult> {
  let url: URL
  try {
    url = new URL(String(request.url))
  } catch {
    return { ok: false, error: `not a URL: ${String(request.url)}` }
  }
  const headers = headersOf(request.headers)
  if (typeof headers === 'string') return { ok: false, error: headers }
  let method = String(request.method ?? 'GET').trim().toUpperCase()
  if (method === '') method = 'GET'
  if (!/^[A-Z]+$/.test(method)) return { ok: false, error: `not an HTTP method: ${method}` }
  let body = request.body === undefined ? undefined : String(request.body)
  if (body !== undefined && (method === 'GET' || method === 'HEAD')) {
    return { ok: false, error: `a ${method} request cannot carry a body` }
  }
  const budget = AbortSignal.timeout(limits.timeoutMs)
  const signal = limits.signal === undefined ? budget : AbortSignal.any([budget, limits.signal])

  for (let hop = 0; ; hop++) {
    const refusal = await reachable(url, limits)
    if (refusal !== undefined) return { ok: false, error: refusal }
    let response: Response
    try {
      response = await fetch(url, { method, headers, body, redirect: 'manual', signal })
    } catch (error) {
      const cancelled = limits.signal?.aborted === true
      return { ok: false, error: cancelled ? 'the request was cancelled' : describe(error) }
    }
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
    if (location === null) {
      const text = await readBody(response, limits.maxBytes)
      if (!text.ok) return { ok: false, error: text.error }
      return {
        ok: true, url: url.href, status: response.status, statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()), body: text.value,
      }
    }
    if (hop >= MAX_REDIRECTS) return { ok: false, error: `${response.status}: more than ${MAX_REDIRECTS} redirects` }
    try {
      url = new URL(location, url)
    } catch {
      return { ok: false, error: `${response.status}: bad redirect to ${location}` }
    }
    // A 301/302/303 turns the request into a plain GET; 307/308 replay it as it was.
    if ((response.status === 301 || response.status === 302 || response.status === 303) && method !== 'HEAD') {
      method = 'GET'
      body = undefined
    }
  }
}

/**
 * Why a card may not reach a URL, if it may not.
 * @param url - the target of this hop.
 * @param limits - reachability rules.
 * @returns the refusal, or `undefined` when the request may go ahead.
 */
async function reachable(url: URL, limits: FetchLimits): Promise<string | undefined> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `only http and https are allowed (${url.protocol})`
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (limits.hosts.length > 0 && !limits.hosts.some(pattern => matches(pattern, host))) {
    return `${host} is not a host a card may reach`
  }
  if (limits.allowPrivate) return undefined
  const addresses = isIP(host) !== 0
    ? [host]
    : await lookup(host, { all: true }).then(found => found.map(one => one.address), () => [])
  if (addresses.length === 0) return `${host} does not resolve`
  const blocked = addresses.find(privateAddress)
  return blocked === undefined ? undefined : `${host} resolves to a private address (${blocked})`
}

/** Whether a host name matches one allowlist pattern (`*` matches any span of characters). */
function matches(pattern: string, host: string): boolean {
  const rule = pattern.trim().toLowerCase()
  if (rule === '') return false
  if (rule === '*') return true
  const target = host.toLowerCase()
  if (!rule.includes('*')) return rule === target
  const escaped = rule.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${escaped}$`).test(target)
}

/** Whether an address is loopback, private, link-local, carrier-grade NAT or otherwise not public. */
function privateAddress(address: string): boolean {
  switch (isIP(address)) {
    case 4: return privateV4(address)
    case 6: {
      const lower = address.toLowerCase()
      const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
      if (mapped !== null) return privateV4(mapped[1]!)
      return lower === '::' || lower === '::1' || /^fe[89ab]/.test(lower) || /^f[cd]/.test(lower)
    }
    default: return false
  }
}

/** Whether a dotted-quad address is outside the public range. */
function privateV4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts as [number, number, number, number]
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
}

/**
 * The request headers as a plain object.
 * @param headers - what the card passed.
 * @returns the headers, or the reason they are unusable.
 */
function headersOf(headers: Record<string, string> | undefined): Record<string, string> | string {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    const key = String(name).trim()
    const text = String(value)
    if (!HEADER_NAME.test(key)) return `not a header name: ${key}`
    if (/[\r\n\0]/.test(text)) return `header ${key} carries a line break`
    out[key] = text
  }
  return out
}

/**
 * Read the response body as text, refusing anything over the cap.
 * @param response - the platform response.
 * @param maxBytes - the cap.
 * @returns the text, or the reason it was refused.
 */
async function readBody(response: Response, maxBytes: number): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, error: `the response declares ${declared} bytes; a card may receive at most ${maxBytes}` }
  }
  if (response.body === null) return { ok: true, value: '' }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return { ok: false, error: `the response exceeds ${maxBytes} bytes` }
    }
    chunks.push(Buffer.from(value))
  }
  return { ok: true, value: Buffer.concat(chunks).toString('utf8') }
}

/** One request failure as the card reads it. */
function describe(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'the request timed out'
    return error.message
  }
  return String(error)
}
