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

describe('room queue and WebRTC signaling', () => {
  test('shares participants and relays offers from the assigned broadcaster', async () => {
    const room = createRoom()
    const base = `ws://localhost:${server.port}/ws?room=${room.id}`
    const owner = new WebSocket(
      `${base}&peer=owner-test&name=Jake&token=${room.ownerToken}`,
    )
    await opened(owner)

    const rosterPromise = nextMessage(
      owner,
      (value) => value.type === 'room:snapshot' && value.room.participants.length === 2,
    )
    const guest = new WebSocket(`${base}&peer=guest-test&name=Maya`)
    await opened(guest)

    const roster = await rosterPromise
    expect(roster.room.participants).toEqual([
      { id: 'owner-test', displayName: 'Jake', isOwner: true },
      { id: 'guest-test', displayName: 'Maya', isOwner: false },
    ])

    const assignmentPromise = nextMessage(
      owner,
      (value) => value.type === 'room:snapshot' && value.room.playback?.entry.ownerPeerId === 'guest-test',
    )
    guest.send(JSON.stringify({ type: 'queue:add', ...track('guest-track', 'Maya Song') }))
    await assignmentPromise

    const offerPromise = nextMessage(owner, (value) => value.type === 'offer')
    guest.send(
      JSON.stringify({
        type: 'offer',
        to: 'owner-test',
        description: { type: 'offer', sdp: 'test-sdp' },
      }),
    )

    const offer = await offerPromise
    expect(offer.from).toBe('guest-test')
    expect(offer.description.sdp).toBe('test-sdp')

    owner.close()
    guest.close()
  })

  test('rotates the queue after the owner leaves', async () => {
    const room = createRoom()
    const base = `ws://localhost:${server.port}/ws?room=${room.id}`
    const owner = new WebSocket(
      `${base}&peer=room-owner&name=Owner&token=${room.ownerToken}`,
    )
    const first = new WebSocket(`${base}&peer=first-dj&name=First`)
    const second = new WebSocket(`${base}&peer=second-dj&name=Second`)
    await Promise.all([opened(owner), opened(first), opened(second)])

    const firstAssigned = nextMessage(
      first,
      (value) => value.type === 'room:snapshot' && value.room.playback?.entry.ownerPeerId === 'first-dj',
    )
    first.send(JSON.stringify({ type: 'queue:add', ...track('first-track', 'First Song') }))
    const firstSnapshot = await firstAssigned
    const firstEpoch = firstSnapshot.room.playback.epoch

    const secondQueued = nextMessage(
      second,
      (value) => value.type === 'room:snapshot' && value.room.queue.length === 1,
    )
    second.send(JSON.stringify({ type: 'queue:add', ...track('second-track', 'Second Song') }))
    await secondQueued

    const go = nextMessage(first, (value) => value.type === 'playback:go')
    first.send(JSON.stringify({ type: 'playback:ready', epoch: firstEpoch }))
    await go

    const playing = nextMessage(
      second,
      (value) => value.type === 'room:snapshot' && value.room.playback?.phase === 'playing',
    )
    first.send(JSON.stringify({ type: 'playback:started', epoch: firstEpoch }))
    await playing

    const ownerGone = nextMessage(
      second,
      (value) => value.type === 'room:snapshot' && value.room.participants.length === 2,
    )
    owner.close()
    await ownerGone

    const secondAssigned = nextMessage(
      second,
      (value) => value.type === 'room:snapshot' && value.room.playback?.entry.ownerPeerId === 'second-dj',
    )
    first.send(JSON.stringify({ type: 'playback:ended', epoch: firstEpoch }))
    const next = await secondAssigned

    expect(next.room.playback.phase).toBe('starting')
    expect(next.room.queue).toHaveLength(0)
    first.close()
    second.close()
  })

  test('allows the current broadcaster to keep one waiting song', async () => {
    const room = createRoom()
    const url = `ws://localhost:${server.port}/ws?room=${room.id}&peer=solo&name=Solo`
    const solo = new WebSocket(url)
    await opened(solo)

    const assigned = nextMessage(
      solo,
      (value) => value.type === 'room:snapshot' && value.room.playback,
    )
    solo.send(JSON.stringify({ type: 'queue:add', ...track('playing-track', 'Playing') }))
    await assigned

    const waiting = nextMessage(
      solo,
      (value) => value.type === 'room:snapshot' && value.room.queue.length === 1,
    )
    solo.send(JSON.stringify({ type: 'queue:add', ...track('waiting-track', 'Waiting') }))
    const snapshot = await waiting
    expect(snapshot.room.queue[0].title).toBe('Waiting')

    const rejected = nextMessage(
      solo,
      (value) => value.type === 'room:error' && value.code === 'queue_full',
    )
    solo.send(JSON.stringify({ type: 'queue:add', ...track('extra-track', 'Too Many') }))
    expect((await rejected).message).toContain('already have a song waiting')
    solo.close()
  })

  test('rejects a duplicate peer ID instead of replacing the first peer', async () => {
    const room = createRoom()
    const url = `ws://localhost:${server.port}/ws?room=${room.id}&peer=same-peer&name=Same`
    const original = new WebSocket(url)
    await opened(original)

    const duplicate = new WebSocket(url)
    const event = await closed(duplicate)

    expect(event.code).toBe(4009)
    expect(original.readyState).toBe(WebSocket.OPEN)
    original.close()
  })

  test('closes a peer that floods room messages', async () => {
    const room = createRoom()
    const socket = new WebSocket(
      `ws://localhost:${server.port}/ws?room=${room.id}&peer=flood-peer&name=Flood`,
    )
    await opened(socket)

    const socketClosed = closed(socket)
    for (let index = 0; index < 121; index += 1) {
      socket.send(JSON.stringify({ type: 'ice', to: 'nobody', candidate: {} }))
    }

    expect((await socketClosed).code).toBe(4008)
  })
})

function track(localTrackId: string, title: string) {
  return {
    localTrackId,
    title,
    artist: 'Test Artist',
    album: '',
    durationSeconds: 60,
    size: 1_024,
  }
}

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
