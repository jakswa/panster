export type QueueEntry = {
  id: string
  localTrackId: string
  ownerPeerId: string
  title: string
  artist: string | null
  album: string | null
  durationSeconds: number
  size: number
  addedAt: string
}

export type Playback = {
  phase: 'starting' | 'playing'
  entry: QueueEntry
  epoch: number
  startedAt: string | null
}

export type Room = {
  id: string
  ownerToken: string
  createdAt: Date
  lastActiveAt: Date
  queue: QueueEntry[]
  playback: Playback | null
  epoch: number
}

export class RoomCapacityError extends Error {}

const rooms = new Map<string, Room>()
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const roomLifetimeMs = 24 * 60 * 60 * 1000
const maxRooms = 1_000

export function createRoom(): Room {
  pruneExpiredRooms()
  if (rooms.size >= maxRooms) {
    throw new RoomCapacityError('Room capacity reached')
  }

  let id = ''
  do {
    const bytes = crypto.getRandomValues(new Uint8Array(6))
    id = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
  } while (rooms.has(id))

  const now = new Date()
  const room: Room = {
    id,
    ownerToken: randomToken(),
    createdAt: now,
    lastActiveAt: now,
    queue: [],
    playback: null,
    epoch: 0,
  }
  rooms.set(id, room)
  return room
}

export function getRoom(id: string) {
  const normalizedId = id.toUpperCase()
  const room = rooms.get(normalizedId)
  if (!room) return null

  if (room.lastActiveAt.getTime() <= Date.now() - roomLifetimeMs) {
    rooms.delete(normalizedId)
    return null
  }

  return room
}

export function touchRoom(id: string) {
  const room = getRoom(id)
  if (room) room.lastActiveAt = new Date()
  return room
}

export function canJoinAsOwner(id: string, token: string | undefined) {
  const room = getRoom(id)
  return Boolean(room && token && timingSafeEqual(room.ownerToken, token))
}

function pruneExpiredRooms() {
  const cutoff = Date.now() - roomLifetimeMs
  for (const [id, room] of rooms) {
    if (room.lastActiveAt.getTime() <= cutoff) rooms.delete(id)
  }
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return Buffer.from(bytes).toString('base64url')
}

function timingSafeEqual(expected: string, actual: string) {
  const expectedBytes = Buffer.from(expected)
  const actualBytes = Buffer.from(actual)
  return (
    expectedBytes.length === actualBytes.length &&
    crypto.timingSafeEqual(expectedBytes, actualBytes)
  )
}
