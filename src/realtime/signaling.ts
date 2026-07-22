import { upgradeWebSocket, websocket } from 'hono/bun'
import type { Context } from 'hono'
import type { WSContext } from 'hono/ws'
import { canJoinAsDj, getRoom, touchRoom } from './room-registry'

type Role = 'dj' | 'guest'
type Peer = {
  id: string
  role: Role
  socket: WSContext
}

const rooms = new Map<string, Map<string, Peer>>()
const roomPattern = /^[A-Z0-9]{6}$/
const peerPattern = /^[a-zA-Z0-9-]{1,64}$/
const signalTypes = new Set(['offer', 'answer', 'ice'])
const maxRoomSize = 12
const signalWindowMs = 10_000
const maxSignalsPerWindow = 120
const maxSignalBytes = 64_000

export async function signalingRoute(c: Context) {
  const roomId = c.req.query('room')?.toUpperCase() ?? ''
  const peerId = c.req.query('peer') ?? ''
  const requestedRole: Role = c.req.query('role') === 'dj' ? 'dj' : 'guest'
  const token = c.req.query('token')

  if (!roomPattern.test(roomId) || !peerPattern.test(peerId)) {
    return c.text('Invalid room or peer ID', 400)
  }
  if (!getRoom(roomId)) return c.text('Room not found', 404)
  if (requestedRole === 'dj' && !canJoinAsDj(roomId, token)) {
    return c.text('Invalid DJ credentials', 403)
  }

  const role = requestedRole
  const signalTimes: number[] = []

  return upgradeWebSocket(c, {
    onOpen(_event, socket) {
      const room = rooms.get(roomId) ?? new Map<string, Peer>()
      if (room.has(peerId)) {
        socket.close(4009, 'Peer ID is already connected')
        return
      }
      if (room.size >= maxRoomSize) {
        socket.close(4003, 'Room is full')
        return
      }

      room.set(peerId, { id: peerId, role, socket })
      rooms.set(roomId, room)
      touchRoom(roomId)
      broadcastRoster(roomId)
    },

    onMessage(event, socket) {
      if (!acceptSignal(signalTimes)) {
        socket.close(4008, 'Signaling rate limit exceeded')
        return
      }
      if (typeof event.data !== 'string' || event.data.length > maxSignalBytes) {
        socket.close(4007, 'Invalid signaling message')
        return
      }

      let message: Record<string, unknown>
      try {
        message = JSON.parse(event.data) as Record<string, unknown>
      } catch {
        return
      }

      const type = typeof message.type === 'string' ? message.type : ''
      const to = typeof message.to === 'string' ? message.to : ''
      if (!signalTypes.has(type) || !peerPattern.test(to)) return

      const target = rooms.get(roomId)?.get(to)
      if (!target) return

      touchRoom(roomId)
      sendJson(target.socket, { ...message, from: peerId, to: undefined })
    },

    onClose(_event, socket) {
      const room = rooms.get(roomId)
      if (!room || room.get(peerId)?.socket.raw !== socket.raw) return

      room.delete(peerId)
      if (room.size === 0) {
        rooms.delete(roomId)
      } else {
        broadcastRoster(roomId)
      }
    },
  })
}

function acceptSignal(signalTimes: number[]) {
  const now = Date.now()
  const cutoff = now - signalWindowMs
  while (signalTimes[0] && signalTimes[0] < cutoff) signalTimes.shift()
  if (signalTimes.length >= maxSignalsPerWindow) return false

  signalTimes.push(now)
  return true
}

function broadcastRoster(roomId: string) {
  const room = rooms.get(roomId)
  if (!room) return

  const peers = Array.from(room.values(), ({ id, role }) => ({ id, role }))
  for (const peer of room.values()) {
    sendJson(peer.socket, { type: 'peers', peers })
  }
}

function sendJson(socket: WSContext, value: unknown) {
  if (socket.readyState !== 1) return
  socket.send(JSON.stringify(value))
}

export { websocket }
