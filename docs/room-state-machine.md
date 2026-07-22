# Room state machine

The Bun server owns queue order and playback authority. Browsers own files, decoding, and media transport.

## Conceptual state

```ts
type RoomState = {
  id: string
  ownerToken: string
  participants: Map<string, Participant>
  queue: QueueEntry[]
  playback: PlaybackState
  epoch: number
  createdAt: Date
  lastActiveAt: Date
}

type Participant = {
  id: string
  displayName: string
  connected: boolean
}

type QueueEntry = {
  id: string
  ownerParticipantId: string
  title: string
  artist: string | null
  album: string | null
  durationSeconds: number
  addedAt: Date
}

type PlaybackState =
  | { phase: 'idle' }
  | { phase: 'starting'; entry: QueueEntry; epoch: number }
  | {
      phase: 'playing'
      entry: QueueEntry
      epoch: number
      startedAt: Date
      expectedEndAt: Date
    }
```

Actual TypeScript may differ, but the invariants should not.

## Invariants

1. Queue order is server-authoritative.
2. A participant owns at most one queued or playing entry.
3. Only the participant owning the current entry may become broadcaster.
4. Playback messages must include the current epoch.
5. Messages from an old epoch cannot stop or advance newer playback.
6. A disconnected participant cannot retain a queue entry.
7. At most one entry is in `starting` or `playing` state.
8. The owner capability grants moderation only; it does not grant broadcaster status for another participant's song.

## Client-to-server events

Names are provisional.

```text
participant:join       { displayName }
queue:add              { localTrackId, title, artist, album, durationSeconds }
queue:remove           { queueEntryId }
playback:ready         { queueEntryId, epoch }
playback:started       { queueEntryId, epoch }
playback:ended         { queueEntryId, epoch }
owner:skip             { queueEntryId, epoch, ownerToken }
```

The server validates metadata lengths, duration bounds, participant ownership, room membership, rate limits, and epoch before changing state.

`localTrackId` identifies the `File` retained in the submitting browser. It is meaningful only to that browser and is never treated as a server-side file reference.

## Server-to-client events

```text
room:snapshot          { participants, queue, playback, epoch }
participant:joined
participant:left
queue:changed
playback:assigned      { entry, epoch }
playback:started       { entry, epoch, startedAt }
playback:stopped       { entry, epoch, reason }
room:error             { code, message }
```

A complete snapshot is sent after joining or reconnecting. Incremental events make the UI responsive, but clients should always be able to replace local state with a newer snapshot.

## Normal transition

```text
idle
  │ queue receives first entry
  ▼
starting
  │ owning browser prepares audio graph and WebRTC peers
  │ browser reports ready, then starts
  ▼
playing
  │ AudioBufferSourceNode emits ended
  │ broadcaster reports playback:ended
  ▼
idle
  │ server immediately assigns next valid queue entry
  └──────────────────────────────────────────────────────► starting
```

There is deliberately no transition phase between songs.

## Assignment and start policy

When assigning an entry:

1. Increment the room epoch.
2. Remove the entry from the waiting queue and place it in `starting`.
3. Notify the owner browser that it is the broadcaster.
4. The browser decodes the track if necessary and establishes outgoing peer connections.
5. Start when all currently connected listeners are ready or after a short maximum wait, initially two seconds.
6. Late listeners join the live stream in progress.

If preparation fails, remove the entry, notify its owner, and assign the next entry.

## End authority and watchdog

The normal end signal comes from the broadcaster's local `ended` event. The server also starts a watchdog using the declared duration plus a grace period.

The watchdog prevents a crashed or malicious broadcaster from holding the room forever. When it fires, the server stops the current epoch and advances.

The owner may skip immediately. The broadcaster may also explicitly stop its own entry.

## Disconnect behavior

- Queued participant disconnects: remove their entry.
- Current broadcaster disconnects: stop the epoch and assign the next entry.
- Owner disconnects: no playback change.
- Listener disconnects: remove them from broadcaster fanout.
- Room becomes empty: retain briefly for reconnect, then expire normally.

## Initial persistence boundary

All state remains in memory on one Fly.io machine. This supports creator dropout but not process restart or multi-machine routing.

PostgreSQL is a later step for durable room identity, queue history, and reconnect state. It cannot preserve WebRTC connections; peers must renegotiate after any server restart regardless.
