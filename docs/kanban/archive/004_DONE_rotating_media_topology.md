# Rotating media topology

- **Status:** DONE
- **Type:** Epic
- **Depends on:** [001](001_DONE_shared_queue_and_rotating_broadcaster.md)

## Principle

The participant who owns the current queue entry is the temporary media hub. The room creator and Fly.io server are not permanent media hubs.

```text
                         ┌── Listener A
Current broadcaster ─────┼── Listener B
                         └── Listener C

Fly.io application: room state and WebRTC signaling only
```

Each line is a direct WebRTC connection. The browser normally sends Opus audio produced by its Web Audio graph. Source MP3 bytes remain on that browser.

## Topology lifecycle

### No song playing

There are no outgoing media peer connections. Participants remain connected to the room WebSocket.

### Entry assigned

1. Server designates the queue-entry owner as broadcaster for a new epoch.
2. The broadcaster creates a `MediaStreamAudioDestinationNode` output.
3. It creates one `RTCPeerConnection` per connected listener.
4. The designated broadcaster always creates offers, avoiding negotiation glare.
5. Listeners answer and attach the incoming track to their listening graph.

### Song starts

The broadcaster routes the local decoded track to both:

- its local monitor, and
- the outgoing media destination.

The broadcaster does not need a loopback WebRTC connection to hear itself.

### Song ends

1. The local source emits `ended`.
2. The broadcaster reports the current epoch ended.
3. Server broadcasts the stop and assigns the next entry.
4. Old peer connections close when the next entry belongs to a different participant.
5. The new broadcaster creates a fresh star topology.

When consecutive entries belong to the same participant, Panster keeps that participant's existing media connections and replaces only the local source under a new epoch. A short, explicit gap remains acceptable.

### Listener joins mid-song

The server adds the listener to the room roster and instructs the current broadcaster to offer a connection. The listener begins at the live position; the song does not restart.

## Why this topology

- The creator can leave without ending the room.
- The application server carries no music traffic.
- A participant only uploads while their own song is playing.
- Every queue boundary is a clean recovery and topology boundary.
- At the current twelve-person room limit, browser fanout is reasonable.

## Expected costs

For `N` listeners, the broadcaster sends approximately `N` encoded audio streams. Upload bandwidth and encoding work move between participants as the queue advances.

The diagnostics panel should continue showing selected candidate types, transport, bitrate, and RTT. During a broadcaster change, status should explicitly move through:

```text
Song ended → Connecting to next broadcaster → Playing
```

## Signaling authorization

The server must only relay broadcaster offers for the participant assigned to the current epoch. Listeners may send answers and ICE candidates only for an expected current-broadcaster connection.

This is stricter than the prototype's role query parameter. The server's queue assignment, participant identity, and epoch become the authority.

## Relationship to current DataChannel transfer

The existing guest-to-DJ MP3 DataChannel proves useful WebRTC behavior but is not required for the shared queue. A participant already owns the MP3 they will broadcast.

Keep the transfer implementation isolated while rebuilding the topology. It may later support requests or track handoff, but it should not complicate the first queue release.

## Browser constraints

- Entering the room must include a user gesture that creates or resumes `AudioContext`.
- Adding a song should prepare enough local state that later assignment can start reliably.
- A suspended mobile tab may be unable to broadcast and must be skipped.
- The current song cannot survive broadcaster closure because no other peer owns its source audio.
- Nearby listener devices are not synchronized speakers and may echo if played aloud together.

## Deferred optimizations

Do not implement these until hard handoffs are solid:

- Preconnecting the next broadcaster
- Dual incoming streams
- Crossfading
- Peer-connection reuse
- SFU fanout
- Relay trees
- Replicating source tracks for failover
