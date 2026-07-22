import { upgradeWebSocket, websocket } from 'hono/bun'
import type { Context } from 'hono'
import type { WSContext } from 'hono/ws'
import {
  canJoinAsOwner,
  getRoom,
  touchRoom,
  type QueueEntry,
  type Room,
} from './room-registry'

type Peer = {
  id: string
  displayName: string
  isOwner: boolean
  socket: WSContext
}

const peersByRoom = new Map<string, Map<string, Peer>>()
const preparationTimers = new Map<string, ReturnType<typeof setTimeout>>()
const playbackTimers = new Map<string, ReturnType<typeof setTimeout>>()
const readyEpochs = new Map<string, number>()
const roomPattern = /^[A-Z0-9]{6}$/
const peerPattern = /^[a-zA-Z0-9-]{1,64}$/
const localTrackPattern = /^[a-zA-Z0-9-]{1,64}$/
const signalTypes = new Set(['offer', 'answer', 'ice', 'ice:restart-request'])
const maxRoomSize = 12
const signalWindowMs = 10_000
const maxSignalsPerWindow = 120
const iceRestartWindowMs = 60_000
const maxIceRestartsPerWindow = 3
const maxSignalBytes = 64_000
const maxTrackBytes = 150 * 1024 * 1024
const maxTrackDurationSeconds = 4 * 60 * 60
const preparationTimeoutMs = 30_000
const startConfirmationTimeoutMs = 5_000
const playbackGraceMs = 15_000

export async function signalingRoute(c: Context) {
  const roomId = c.req.query('room')?.toUpperCase() ?? ''
  const peerId = c.req.query('peer') ?? ''
  const displayName = cleanText(c.req.query('name'), 40) || 'Anonymous'
  const token = c.req.query('token')

  if (!roomPattern.test(roomId) || !peerPattern.test(peerId)) {
    return c.text('Invalid room or peer ID', 400)
  }
  if (!getRoom(roomId)) return c.text('Room not found', 404)
  if (token && !canJoinAsOwner(roomId, token)) {
    return c.text('Invalid owner credentials', 403)
  }

  const signalTimes: number[] = []
  const iceRestartTimes: number[] = []

  return upgradeWebSocket(c, {
    onOpen(_event, socket) {
      const peers = peersByRoom.get(roomId) ?? new Map<string, Peer>()
      if (peers.has(peerId)) {
        socket.close(4009, 'Peer ID is already connected')
        return
      }
      if (peers.size >= maxRoomSize) {
        socket.close(4003, 'Room is full')
        return
      }

      peers.set(peerId, {
        id: peerId,
        displayName,
        isOwner: Boolean(token),
        socket,
      })
      peersByRoom.set(roomId, peers)
      touchRoom(roomId)
      broadcastSnapshot(roomId)
    },

    onMessage(event, socket) {
      if (!acceptSignal(signalTimes)) {
        socket.close(4008, 'Room message rate limit exceeded')
        return
      }
      if (typeof event.data !== 'string' || event.data.length > maxSignalBytes) {
        socket.close(4007, 'Invalid room message')
        return
      }

      let message: Record<string, unknown>
      try {
        message = JSON.parse(event.data) as Record<string, unknown>
      } catch {
        return
      }

      const peer = peersByRoom.get(roomId)?.get(peerId)
      const room = getRoom(roomId)
      if (!peer || !room) return

      const type = typeof message.type === 'string' ? message.type : ''
      if (
        type === 'ice:restart-request' &&
        !acceptIceRestart(iceRestartTimes)
      ) return
      if (signalTypes.has(type)) {
        relaySignal(room, peer, type, message)
        return
      }

      if (type === 'queue:add') {
        addToQueue(room, peer, message)
      } else if (type === 'queue:remove') {
        removeFromQueue(room, peer, message)
      } else if (type === 'playback:ready') {
        markPlaybackReady(room, peer, message)
      } else if (type === 'playback:started') {
        markPlaybackStarted(room, peer, message)
      } else if (type === 'playback:ended') {
        endPlayback(room, peer, message, 'finished')
      } else if (type === 'playback:failed') {
        endPlayback(room, peer, message, 'could not start')
      } else if (type === 'owner:skip') {
        if (peer.isOwner && room.playback) stopAndAdvance(room, 'skipped by the room owner')
      }
    },

    onClose(_event, socket) {
      const peers = peersByRoom.get(roomId)
      if (!peers || peers.get(peerId)?.socket.raw !== socket.raw) return

      peers.delete(peerId)
      const room = getRoom(roomId)
      if (room) {
        room.queue = room.queue.filter((entry) => entry.ownerPeerId !== peerId)
        if (room.playback?.entry.ownerPeerId === peerId) {
          stopAndAdvance(room, 'broadcaster disconnected')
        } else {
          touchRoom(roomId)
          broadcastSnapshot(roomId)
        }
      }

      if (peers.size === 0) {
        peersByRoom.delete(roomId)
        clearPlaybackTimers(roomId)
        readyEpochs.delete(roomId)
        if (room) {
          room.queue = []
          room.playback = null
        }
      }
    },
  })
}

function relaySignal(
  room: Room,
  peer: Peer,
  type: string,
  message: Record<string, unknown>,
) {
  const to = typeof message.to === 'string' ? message.to : ''
  if (!peerPattern.test(to) || to === peer.id) return

  const target = peersByRoom.get(room.id)?.get(to)
  const broadcasterId = room.playback?.entry.ownerPeerId
  if (!target || !broadcasterId) return

  const allowed =
    (type === 'offer' && peer.id === broadcasterId && to !== broadcasterId) ||
    (type === 'answer' && peer.id !== broadcasterId && to === broadcasterId) ||
    (type === 'ice:restart-request' &&
      peer.id !== broadcasterId &&
      to === broadcasterId) ||
    (type === 'ice' &&
      ((peer.id === broadcasterId && to !== broadcasterId) ||
        (peer.id !== broadcasterId && to === broadcasterId)))
  if (!allowed) return

  touchRoom(room.id)
  const { to: _to, ...payload } = message
  sendJson(target.socket, { ...payload, from: peer.id })
}

function addToQueue(room: Room, peer: Peer, message: Record<string, unknown>) {
  if (room.queue.some((entry) => entry.ownerPeerId === peer.id)) {
    sendError(peer, 'queue_full', 'You already have a song waiting in the queue.')
    return
  }

  const localTrackId = typeof message.localTrackId === 'string' ? message.localTrackId : ''
  const title = cleanText(message.title, 120)
  const artist = cleanText(message.artist, 120) || null
  const album = cleanText(message.album, 120) || null
  const durationSeconds = Number(message.durationSeconds)
  const size = Number(message.size)

  if (
    !localTrackPattern.test(localTrackId) ||
    !title ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > maxTrackDurationSeconds ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > maxTrackBytes
  ) {
    sendError(peer, 'invalid_track', 'That track could not be added to the queue.')
    return
  }

  const entry: QueueEntry = {
    id: crypto.randomUUID(),
    localTrackId,
    ownerPeerId: peer.id,
    title,
    artist,
    album,
    durationSeconds: Math.round(durationSeconds * 10) / 10,
    size,
    addedAt: new Date().toISOString(),
  }
  room.queue.push(entry)
  touchRoom(room.id)

  if (!room.playback) {
    assignNext(room)
  } else {
    broadcastSnapshot(room.id)
  }
}

function removeFromQueue(room: Room, peer: Peer, message: Record<string, unknown>) {
  const entryId = typeof message.entryId === 'string' ? message.entryId : ''
  const entry = room.queue.find((candidate) => candidate.id === entryId)
  if (!entry || (entry.ownerPeerId !== peer.id && !peer.isOwner)) return

  room.queue = room.queue.filter((candidate) => candidate.id !== entryId)
  touchRoom(room.id)
  broadcastSnapshot(room.id)
}

function assignNext(room: Room) {
  if (room.playback) return

  const peers = peersByRoom.get(room.id)
  let entry: QueueEntry | undefined
  while (room.queue.length && !entry) {
    const candidate = room.queue.shift()!
    if (peers?.has(candidate.ownerPeerId)) entry = candidate
  }

  if (!entry) {
    broadcastSnapshot(room.id)
    return
  }

  room.epoch += 1
  room.playback = {
    phase: 'starting',
    entry,
    epoch: room.epoch,
    startedAt: null,
  }
  readyEpochs.delete(room.id)
  schedulePreparationTimeout(room)
  touchRoom(room.id)
  broadcastSnapshot(room.id)
}

function markPlaybackReady(room: Room, peer: Peer, message: Record<string, unknown>) {
  const playback = room.playback
  const epoch = Number(message.epoch)
  if (
    !playback ||
    playback.phase !== 'starting' ||
    playback.epoch !== epoch ||
    playback.entry.ownerPeerId !== peer.id ||
    readyEpochs.get(room.id) === epoch
  ) return

  readyEpochs.set(room.id, epoch)
  clearTimer(preparationTimers, room.id)
  sendJson(peer.socket, { type: 'playback:go', epoch })
  preparationTimers.set(
    room.id,
    setTimeout(() => {
      const current = getRoom(room.id)?.playback
      if (current?.phase === 'starting' && current.epoch === epoch) {
        stopAndAdvance(room, 'broadcaster did not start')
      }
    }, startConfirmationTimeoutMs),
  )
}

function markPlaybackStarted(room: Room, peer: Peer, message: Record<string, unknown>) {
  const playback = room.playback
  const epoch = Number(message.epoch)
  if (
    !playback ||
    playback.phase !== 'starting' ||
    playback.epoch !== epoch ||
    playback.entry.ownerPeerId !== peer.id ||
    readyEpochs.get(room.id) !== epoch
  ) return

  clearTimer(preparationTimers, room.id)
  playback.phase = 'playing'
  playback.startedAt = new Date().toISOString()
  const watchdogMs = playback.entry.durationSeconds * 1_000 + playbackGraceMs
  playbackTimers.set(
    room.id,
    setTimeout(() => {
      const current = getRoom(room.id)?.playback
      if (current?.epoch === epoch) stopAndAdvance(room, 'playback timed out')
    }, watchdogMs),
  )
  touchRoom(room.id)
  broadcastSnapshot(room.id)
}

function endPlayback(
  room: Room,
  peer: Peer,
  message: Record<string, unknown>,
  reason: string,
) {
  const playback = room.playback
  const epoch = Number(message.epoch)
  if (!playback || playback.epoch !== epoch || playback.entry.ownerPeerId !== peer.id) return
  stopAndAdvance(room, reason)
}

function stopAndAdvance(room: Room, reason: string) {
  if (!room.playback) return

  const stopped = room.playback
  clearPlaybackTimers(room.id)
  readyEpochs.delete(room.id)
  room.playback = null
  touchRoom(room.id)
  broadcast(room.id, {
    type: 'playback:stopped',
    epoch: stopped.epoch,
    reason,
  })
  assignNext(room)
}

function schedulePreparationTimeout(room: Room) {
  clearTimer(preparationTimers, room.id)
  const epoch = room.playback?.epoch
  preparationTimers.set(
    room.id,
    setTimeout(() => {
      const current = getRoom(room.id)?.playback
      if (current?.phase === 'starting' && current.epoch === epoch) {
        stopAndAdvance(room, 'track preparation timed out')
      }
    }, preparationTimeoutMs),
  )
}

function broadcastSnapshot(roomId: string) {
  const room = getRoom(roomId)
  const peers = peersByRoom.get(roomId)
  if (!room || !peers) return

  const participants = Array.from(peers.values(), (peer) => ({
    id: peer.id,
    displayName: peer.displayName,
    isOwner: peer.isOwner,
  }))
  const shared = {
    id: room.id,
    participants,
    queue: room.queue,
    playback: room.playback,
    epoch: room.epoch,
  }

  for (const peer of peers.values()) {
    sendJson(peer.socket, {
      type: 'room:snapshot',
      room: shared,
      you: { id: peer.id, isOwner: peer.isOwner },
    })
  }
}

function broadcast(roomId: string, value: unknown) {
  const peers = peersByRoom.get(roomId)
  if (!peers) return
  for (const peer of peers.values()) sendJson(peer.socket, value)
}

function sendError(peer: Peer, code: string, message: string) {
  sendJson(peer.socket, { type: 'room:error', code, message })
}

function acceptSignal(signalTimes: number[]) {
  const now = Date.now()
  const cutoff = now - signalWindowMs
  while (signalTimes[0] && signalTimes[0] < cutoff) signalTimes.shift()
  if (signalTimes.length >= maxSignalsPerWindow) return false

  signalTimes.push(now)
  return true
}

function acceptIceRestart(restartTimes: number[]) {
  const now = Date.now()
  const cutoff = now - iceRestartWindowMs
  while (restartTimes[0] && restartTimes[0] < cutoff) restartTimes.shift()
  if (restartTimes.length >= maxIceRestartsPerWindow) return false

  restartTimes.push(now)
  return true
}

function cleanText(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return ''
  return value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength)
}

function clearPlaybackTimers(roomId: string) {
  clearTimer(preparationTimers, roomId)
  clearTimer(playbackTimers, roomId)
}

function clearTimer(
  timers: Map<string, ReturnType<typeof setTimeout>>,
  roomId: string,
) {
  const timer = timers.get(roomId)
  if (timer) clearTimeout(timer)
  timers.delete(roomId)
}

function sendJson(socket: WSContext, value: unknown) {
  if (socket.readyState !== 1) return
  socket.send(JSON.stringify(value))
}

export { websocket }
