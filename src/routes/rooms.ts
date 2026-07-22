import { Hono } from 'hono'
import { createHmac } from 'node:crypto'
import {
  canJoinAsOwner,
  createRoom,
  getRoom,
  RoomCapacityError,
  touchRoom,
} from '../realtime/room-registry'
import { env } from '../utils/env'

export const roomRoutes = new Hono()

const roomCreationTimes: number[] = []
const maxRoomCreationsPerMinute = 30
const turnCredentialTimes = new Map<string, number[]>()
const turnCredentialLimits = {
  global: 600,
  client: 60,
  roomClient: 30,
}
const peerPattern = /^[a-zA-Z0-9-]{1,64}$/

roomRoutes.post('/rooms', (c) => {
  if (!allowRoomCreation()) {
    c.header('Retry-After', '60')
    return c.text('Too many rooms created. Try again shortly.', 429)
  }

  try {
    const room = createRoom()
    return c.redirect(
      `/rooms/${room.id}?owner=${encodeURIComponent(room.ownerToken)}`,
      303,
    )
  } catch (error) {
    if (error instanceof RoomCapacityError) {
      return c.text('Room capacity reached. Try again later.', 503)
    }
    throw error
  }
})

roomRoutes.get('/join', (c) => {
  const roomId = c.req.query('room')?.trim().toUpperCase() ?? ''
  return /^[A-Z0-9]{6}$/.test(roomId)
    ? c.redirect(`/rooms/${roomId}`, 302)
    : c.redirect('/', 302)
})

roomRoutes.get('/rooms/:roomId/ice-servers', (c) => {
  const roomId = c.req.param('roomId').toUpperCase()
  if (!getRoom(roomId)) return c.notFound()
  const peerId = c.req.query('peer') ?? ''
  if (!peerPattern.test(peerId)) {
    return c.json({ error: 'Invalid peer ID' }, 400)
  }
  if (!env.TURN_SHARED_SECRET) {
    return c.json({ error: 'TURN is not configured' }, 503)
  }
  const clientIp = c.req.header('Fly-Client-IP') ?? 'direct'
  if (!allowTurnCredentials(roomId, clientIp)) {
    c.header('Retry-After', '60')
    return c.json({ error: 'Too many TURN credential requests' }, 429)
  }

  const expiry = Math.floor(Date.now() / 1000) + 21_600
  const username = `${expiry}:${roomId}:${peerId}`
  const credential = createHmac('sha1', env.TURN_SHARED_SECRET)
    .update(username)
    .digest('base64')

  c.header('Cache-Control', 'private, no-store')
  return c.json({
    expiresAt: expiry,
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302'] },
      {
        urls: [
          `turn:${env.TURN_HOST}:3478?transport=udp`,
          `turn:${env.TURN_HOST}:3478?transport=tcp`,
          `turns:${env.TURN_HOST}:443?transport=tcp`,
        ],
        username,
        credential,
      },
    ],
  })
})

roomRoutes.get('/rooms/:roomId', (c) => {
  const roomId = c.req.param('roomId').toUpperCase()
  const room = getRoom(roomId)
  if (!room) return c.notFound()

  // Accept the prototype's old private DJ URL until existing links expire.
  const token = c.req.query('owner') ??
    (c.req.query('role') === 'dj' ? c.req.query('token') : undefined)
  if (token && !canJoinAsOwner(roomId, token)) {
    return c.text('Invalid owner link', 403)
  }

  touchRoom(roomId)
  c.header('Cache-Control', 'private, no-store')
  return c.var.render('room', {
    title: `Join room ${roomId} · Panster`,
    description: `Join room ${roomId} on Panster. Bring an MP3, add it to the shared queue, and listen together.`,
    canonicalUrl: new URL(`/rooms/${roomId}`, env.PUBLIC_ORIGIN).href,
    roomId,
    ownerToken: token ?? '',
  })
})

function allowRoomCreation() {
  const cutoff = Date.now() - 60_000
  while (roomCreationTimes[0] && roomCreationTimes[0] < cutoff) {
    roomCreationTimes.shift()
  }
  if (roomCreationTimes.length >= maxRoomCreationsPerMinute) return false

  roomCreationTimes.push(Date.now())
  return true
}

function allowTurnCredentials(roomId: string, clientIp: string) {
  const now = Date.now()
  const cutoff = Date.now() - 60_000
  for (const [key, times] of turnCredentialTimes) {
    const current = times.filter((time) => time >= cutoff)
    if (current.length) turnCredentialTimes.set(key, current)
    else turnCredentialTimes.delete(key)
  }

  const buckets = [
    { key: 'global', limit: turnCredentialLimits.global },
    { key: `client:${clientIp}`, limit: turnCredentialLimits.client },
    {
      key: `room-client:${roomId}:${clientIp}`,
      limit: turnCredentialLimits.roomClient,
    },
  ]
  if (buckets.some(({ key, limit }) => (turnCredentialTimes.get(key)?.length ?? 0) >= limit)) {
    return false
  }

  for (const { key } of buckets) {
    const times = turnCredentialTimes.get(key) ?? []
    times.push(now)
    turnCredentialTimes.set(key, times)
  }
  return true
}
