import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const { app } = await import('../src/app')
const { websocket } = await import('../src/realtime/signaling')
const { createRoom } = await import('../src/realtime/room-registry')

let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: app.fetch, websocket })
})

afterAll(() => {
  server.stop(true)
})

describe('WebRTC signaling relay', () => {
  test('shares the room roster and relays an offer', async () => {
    const room = createRoom()
    const base = `ws://localhost:${server.port}/ws?room=${room.id}`
    const dj = new WebSocket(
      `${base}&peer=dj-test&role=dj&token=${room.djToken}`,
    )
    await opened(dj)

    const rosterPromise = nextMessage(
      dj,
      (value) => value.type === 'peers' && value.peers.length === 2,
    )
    const guest = new WebSocket(`${base}&peer=guest-test&role=guest`)
    await opened(guest)

    const roster = await rosterPromise
    expect(roster.peers).toEqual([
      { id: 'dj-test', role: 'dj' },
      { id: 'guest-test', role: 'guest' },
    ])

    const offerPromise = nextMessage(guest, (value) => value.type === 'offer')
    dj.send(
      JSON.stringify({
        type: 'offer',
        to: 'guest-test',
        description: { type: 'offer', sdp: 'test-sdp' },
      }),
    )

    const offer = await offerPromise
    expect(offer.from).toBe('dj-test')
    expect(offer.description.sdp).toBe('test-sdp')

    dj.close()
    guest.close()
  })

  test('rejects a duplicate peer ID instead of replacing the first peer', async () => {
    const room = createRoom()
    const url = `ws://localhost:${server.port}/ws?room=${room.id}&peer=same-peer&role=guest`
    const original = new WebSocket(url)
    await opened(original)

    const duplicate = new WebSocket(url)
    const duplicateClosed = closed(duplicate)
    const event = await duplicateClosed

    expect(event.code).toBe(4009)
    expect(original.readyState).toBe(WebSocket.OPEN)
    original.close()
  })

  test('closes a peer that floods the signaling relay', async () => {
    const room = createRoom()
    const socket = new WebSocket(
      `ws://localhost:${server.port}/ws?room=${room.id}&peer=flood-peer&role=guest`,
    )
    await opened(socket)

    const socketClosed = closed(socket)
    for (let index = 0; index < 121; index += 1) {
      socket.send(JSON.stringify({ type: 'ice', to: 'nobody', candidate: {} }))
    }

    expect((await socketClosed).code).toBe(4008)
  })
})

function opened(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('WebSocket failed')), {
      once: true,
    })
  })
}

function closed(socket: WebSocket) {
  return new Promise<CloseEvent>((resolve) => {
    socket.addEventListener('close', resolve, { once: true })
  })
}

function nextMessage(
  socket: WebSocket,
  predicate: (value: Record<string, any>) => boolean,
) {
  return new Promise<Record<string, any>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', onMessage)
      reject(new Error('Timed out waiting for WebSocket message'))
    }, 3_000)

    function onMessage(event: MessageEvent) {
      const value = JSON.parse(String(event.data)) as Record<string, any>
      if (!predicate(value)) return

      clearTimeout(timeout)
      socket.removeEventListener('message', onMessage)
      resolve(value)
    }

    socket.addEventListener('message', onMessage)
  })
}
