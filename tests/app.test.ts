import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'

const { app } = await import('../src/app')
const { createRoom } = await import('../src/realtime/room-registry')

describe('Panster HTTP app', () => {
  test('home page renders the shared-queue entry point', async () => {
    const res = await app.request('/')

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-cache')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(res.headers.get('content-security-policy')).toContain("media-src 'self' blob:")
    expect(await res.text()).toContain('Everyone gets a turn')
  })

  test('renders text-only sharing metadata for the landing page', async () => {
    const res = await app.request('https://panster.example/')
    const html = await res.text()

    expect(html).toContain(
      '<meta name="description" content="Start a peer-to-peer listening room where friends take turns playing local MP3s. Nothing gets uploaded to Panster.">',
    )
    expect(html).toContain(
      '<link rel="canonical" href="https://panster.example/">',
    )
    expect(html).toContain('<meta property="og:type" content="website">')
    expect(html).toContain('<meta property="og:site_name" content="Panster">')
    expect(html).toContain(
      '<meta property="og:title" content="Panster · Music, passed around">',
    )
    expect(html).toContain(
      '<meta property="og:url" content="https://panster.example/">',
    )
    expect(html).toContain('<meta name="twitter:card" content="summary">')
    expect(html).not.toContain('og:image')
    expect(html).not.toContain('twitter:image')
  })

  test('uses the trusted public origin instead of the request host', async () => {
    const res = await app.request('https://attacker.example/')
    const head = (await res.text()).match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? ''

    expect(head).toContain(
      '<link rel="canonical" href="https://panster.example/">',
    )
    expect(head).toContain(
      '<meta property="og:url" content="https://panster.example/">',
    )
    expect(head).not.toContain('attacker.example')
  })

  test('creates an ephemeral room-owner link', async () => {
    const res = await app.request('http://localhost/rooms', {
      method: 'POST',
      headers: { Origin: 'http://localhost' },
    })

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toMatch(
      /^\/rooms\/[A-Z0-9]{6}\?owner=[a-zA-Z0-9_-]{32}$/,
    )
  })

  test('renders the shared room surface for owners and guests', async () => {
    const room = createRoom()
    const owner = await app.request(
      `/rooms/${room.id}?owner=${room.ownerToken}`,
    )
    const guest = await app.request(`/rooms/${room.id}`)

    expect(owner.status).toBe(200)
    expect(await owner.text()).toContain('Copy room link')
    expect(guest.status).toBe(200)
    expect(await guest.text()).toContain('Add a song')
  })

  test('issues short-lived TURN credentials for a live room', async () => {
    const room = createRoom()
    const before = Math.floor(Date.now() / 1000)
    const res = await app.request(`/rooms/${room.id}/ice-servers?peer=peer-test`)
    const after = Math.floor(Date.now() / 1000)

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')

    const body = await res.json()
    expect(body.iceServers[0]).toEqual({
      urls: ['stun:stun.l.google.com:19302'],
    })
    expect(body.iceServers[1].urls).toEqual([
      'turn:turn.panster.click:3478?transport=udp',
      'turn:turn.panster.click:3478?transport=tcp',
      'turns:turn.panster.click:443?transport=tcp',
    ])

    const [expiry, roomId, peerId] = body.iceServers[1].username.split(':')
    expect(Number(expiry)).toBeGreaterThanOrEqual(before + 21_600)
    expect(Number(expiry)).toBeLessThanOrEqual(after + 21_600)
    expect(body.expiresAt).toBe(Number(expiry))
    expect(roomId).toBe(room.id)
    expect(peerId).toBe('peer-test')
    expect(body.iceServers[1].credential).toBe(
      createHmac('sha1', 'test-turn-shared-secret')
        .update(body.iceServers[1].username)
        .digest('base64'),
    )
    expect(JSON.stringify(body)).not.toContain('test-turn-shared-secret')
  })

  test('requires a valid peer ID before issuing TURN credentials', async () => {
    const room = createRoom()

    expect((await app.request(`/rooms/${room.id}/ice-servers`)).status).toBe(400)
    expect(
      (await app.request(`/rooms/${room.id}/ice-servers?peer=${'x'.repeat(65)}`)).status,
    ).toBe(400)
  })

  test('rate limits TURN credential issuance per room', async () => {
    const room = createRoom()

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const res = await app.request(`/rooms/${room.id}/ice-servers?peer=rate-test`, {
        headers: { 'Fly-Client-IP': '203.0.113.10' },
      })
      expect(res.status).toBe(200)
    }

    const limited = await app.request(`/rooms/${room.id}/ice-servers?peer=rate-test`, {
      headers: { 'Fly-Client-IP': '203.0.113.10' },
    })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
  })

  test('renders shareable room metadata without exposing the owner link', async () => {
    const room = createRoom()
    const res = await app.request(
      `https://panster.example/rooms/${room.id}?owner=${room.ownerToken}`,
    )
    const html = await res.text()
    const head = html.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? ''

    expect(head).toContain(`<title>Join room ${room.id} · Panster</title>`)
    expect(head).toContain(
      `<meta name="description" content="Join room ${room.id} on Panster. Bring an MP3, add it to the shared queue, and listen together.">`,
    )
    expect(head).toContain(
      `<link rel="canonical" href="https://panster.example/rooms/${room.id}">`,
    )
    expect(head).toContain(
      `<meta property="og:title" content="Join room ${room.id} · Panster">`,
    )
    expect(head).toContain(
      `<meta property="og:url" content="https://panster.example/rooms/${room.id}">`,
    )
    expect(head).toContain('<meta name="twitter:card" content="summary">')
    expect(head).not.toContain('owner=')
    expect(head).not.toContain(room.ownerToken)
    expect(head).not.toContain('og:image')
  })

  test('rejects a forged owner capability', async () => {
    const room = createRoom()
    const res = await app.request(`/rooms/${room.id}?owner=wrong`)
    expect(res.status).toBe(403)
  })

  test('serves media-plane code that loads room-scoped ICE servers', async () => {
    const res = await app.request('/assets/test/room.js')
    const script = await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/javascript')
    expect(script).toContain('RTCPeerConnection')
    expect(script).toContain('/ice-servers')
    expect(script).toContain('using direct connections only')
    expect(script).toContain('AbortController')
    expect(script).toContain('expiresAt')
    expect(script).toContain('setConfiguration')
    expect(script).toContain('ice:restart-request')
    expect(script).not.toContain('test-turn-shared-secret')
  })

  test('offers recovery when a temporary room is gone', async () => {
    const res = await app.request('/rooms/STALE1')
    const html = await res.text()

    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(html).toContain('Room STALE1 is gone')
    expect(html).toContain('Rooms are temporary')
    expect(html).toContain('<form method="post" action="/rooms">')
    expect(html).toContain('Start a new room')
    expect(html).not.toContain('Page not found')
  })

  test('rejects malformed room IDs', async () => {
    const res = await app.request('/rooms/not-valid')
    expect(res.status).toBe(404)
  })
})
