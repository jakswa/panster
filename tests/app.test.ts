import { describe, expect, test } from 'bun:test'

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

  test('rejects a forged owner capability', async () => {
    const room = createRoom()
    const res = await app.request(`/rooms/${room.id}?owner=wrong`)
    expect(res.status).toBe(403)
  })

  test('serves the rotating media-plane code', async () => {
    const res = await app.request('/assets/test/room.js')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/javascript')
    expect(await res.text()).toContain('RTCPeerConnection')
  })

  test('rejects malformed room IDs', async () => {
    const res = await app.request('/rooms/not-valid')
    expect(res.status).toBe(404)
  })
})
