/**
 * A card's `fetch` (`src/http.ts`): one bounded request against a real local server, and the refusals that keep a
 * card from reaching the bot's own network — a private address, a host outside the allowlist, a scheme that is not
 * HTTP, a body too large, a request that takes too long.
 */
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import test from 'node:test'
import { cardFetch, type FetchLimits } from '../src/http.ts'

const limits = (over: Partial<FetchLimits> = {}): FetchLimits =>
  ({ timeoutMs: 2000, maxBytes: 1024, hosts: [], allowPrivate: true, ...over })

/** A server on the loopback, and the base URL to reach it. */
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer(handler)
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => { resolve() })
    }),
  }
}

test('a request comes back with its status, headers and body', async () => {
  const server = await serve((req, res) => {
    res.writeHead(201, { 'content-type': 'application/json', 'x-echo': String(req.headers['x-a'] ?? '') })
    res.end(JSON.stringify({ method: req.method, url: req.url }))
  })
  try {
    const result = await cardFetch({ url: `${server.url}/thing`, headers: { 'x-a': '1' } }, limits())
    assert.equal(result.ok, true)
    assert.ok(result.ok)
    assert.equal(result.status, 201)
    assert.equal(result.url, `${server.url}/thing`)
    assert.equal(result.headers['x-echo'], '1')
    assert.deepEqual(JSON.parse(result.body), { method: 'GET', url: '/thing' })
  } finally {
    await server.close()
  }
})

test('a POST carries its body and headers', async () => {
  const server = await serve((req, res) => {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => { res.writeHead(200); res.end(`${req.method} ${req.headers['content-type']}: ${body}`) })
  })
  try {
    const result = await cardFetch({ url: `${server.url}/echo`, method: 'post', headers: { 'content-type': 'text/plain' }, body: 'hi' }, limits())
    assert.ok(result.ok)
    assert.equal(result.body, 'POST text/plain: hi')
  } finally {
    await server.close()
  }
})

test('a body on a GET is refused before anything is sent', async () => {
  const refused = await cardFetch({ url: 'http://127.0.0.1:9/x', body: 'x' }, limits())
  assert.equal(refused.ok, false)
  assert.match(!refused.ok ? refused.error : '', /cannot carry a body/)
})

test('the scheme must be http or https', async () => {
  const refused = await cardFetch({ url: 'file:///etc/passwd' }, limits())
  assert.equal(refused.ok, false)
  assert.match(!refused.ok ? refused.error : '', /only http and https/)
})

test('a private address is refused unless the deployment allows it', async () => {
  const server = await serve((_req, res) => { res.writeHead(200); res.end('internal') })
  try {
    const refused = await cardFetch({ url: `${server.url}/secret` }, limits({ allowPrivate: false }))
    assert.equal(refused.ok, false)
    assert.match(!refused.ok ? refused.error : '', /private address/)
    const allowed = await cardFetch({ url: `${server.url}/secret` }, limits({ allowPrivate: true }))
    assert.equal(allowed.ok, true)
  } finally {
    await server.close()
  }
})

test('an allowlist restricts the hosts a card may reach', async () => {
  const server = await serve((_req, res) => { res.writeHead(200); res.end('ok') })
  try {
    const refused = await cardFetch({ url: `${server.url}/x` }, limits({ hosts: ['api.example.com'] }))
    assert.equal(refused.ok, false)
    assert.match(!refused.ok ? refused.error : '', /not a host a card may reach/)
    const listed = await cardFetch({ url: `${server.url}/x` }, limits({ hosts: ['127.0.0.1'] }))
    assert.equal(listed.ok, true)
    // A `*` matches any span, so a prefix pattern covers the address too.
    const star = await cardFetch({ url: `${server.url}/x` }, limits({ hosts: ['127.*'] }))
    assert.equal(star.ok, true)
  } finally {
    await server.close()
  }
})

test('redirects are followed, and each hop is checked again', async () => {
  const server = await serve((req, res) => {
    if (req.url === '/start') {
      res.writeHead(307, { location: '/end' })
      res.end()
      return
    }
    if (req.url === '/away') {
      res.writeHead(302, { location: 'http://elsewhere.invalid/' })
      res.end()
      return
    }
    res.writeHead(200)
    res.end('landed')
  })
  try {
    const followed = await cardFetch({ url: `${server.url}/start` }, limits())
    assert.ok(followed.ok)
    assert.equal(followed.body, 'landed')
    assert.equal(followed.url, `${server.url}/end`)

    const refused = await cardFetch({ url: `${server.url}/away` }, limits({ hosts: ['127.0.0.1'] }))
    assert.equal(refused.ok, false)
    assert.match(!refused.ok ? refused.error : '', /elsewhere\.invalid is not a host a card may reach/)
  } finally {
    await server.close()
  }
})

test('a response over the byte cap is refused', async () => {
  const server = await serve((_req, res) => { res.writeHead(200); res.end('x'.repeat(4000)) })
  try {
    const refused = await cardFetch({ url: `${server.url}/big` }, limits({ maxBytes: 1024 }))
    assert.equal(refused.ok, false)
    assert.match(!refused.ok ? refused.error : '', /1024 bytes/)
  } finally {
    await server.close()
  }
})

test('a request that takes too long fails with the timeout', async () => {
  const server = await serve(() => { /* never answers */ })
  try {
    const refused = await cardFetch({ url: `${server.url}/slow` }, limits({ timeoutMs: 150 }))
    assert.equal(refused.ok, false)
    assert.match(!refused.ok ? refused.error : '', /timed out/)
  } finally {
    await server.close()
  }
})

test('a header that cannot be sent is refused', async () => {
  const refused = await cardFetch({ url: 'http://127.0.0.1:9/x', headers: { 'bad header': '1' } }, limits())
  assert.equal(refused.ok, false)
  assert.match(!refused.ok ? refused.error : '', /not a header name/)
})
