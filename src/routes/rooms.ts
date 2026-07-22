import { Hono } from 'hono'
import {
  canJoinAsOwner,
  createRoom,
  getRoom,
  RoomCapacityError,
  touchRoom,
} from '../realtime/room-registry'

export const roomRoutes = new Hono()

const roomCreationTimes: number[] = []
const maxRoomCreationsPerMinute = 30

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
    title: `Panster · ${roomId}`,
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
