export type Room = {
  id: string
  djToken: string
  createdAt: Date
  lastActiveAt: Date
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
  const room = {
    id,
    djToken: randomToken(),
    createdAt: now,
    lastActiveAt: now,
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

export function canJoinAsDj(id: string, token: string | undefined) {
  const room = getRoom(id)
  return Boolean(room && token && timingSafeEqual(room.djToken, token))
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
