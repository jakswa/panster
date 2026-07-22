# Implementation plan

## Goal

Replace the permanent creator-host topology with a server-authoritative shared queue whose current entry owner becomes the temporary WebRTC broadcaster.

Keep each phase testable with real browsers. Do not add crossfading, PostgreSQL, AI, or multi-machine support during this plan.

## Phase 1: room participants and metadata queue

Build the social and state layer before changing the working media plane.

### Server

- Add participant display names to in-memory room state.
- Add validated queue entries and one-entry-per-participant enforcement.
- Extend the WebSocket protocol beyond SDP/ICE with typed room events.
- Send a complete room snapshot on join.
- Broadcast participant and queue changes.
- Rename the DJ capability concept to owner/moderator capability.
- Preserve current room expiry, capacity, and rate limits.

### Browser

- Add an **Enter room** step that captures display name and unlocks audio.
- Add local MP3 selection.
- Extract title, artist, album, and duration client-side.
- Show editable title and artist before enqueueing.
- Retain the selected `File` in a local map keyed by queue-entry/local-track ID.
- Render now-playing and queue sections with text-safe DOM APIs.
- Use a generated placeholder instead of embedded album artwork.

### Acceptance

With three browser pages, all see the same participant list and queue order. Metadata looks useful for tagged and untagged MP3s. Disconnecting a queued participant removes their entry. No file bytes reach the server.

## Phase 2: current-broadcaster abstraction

Replace `role=dj` media authority with server assignment.

### Server

- Add `idle`, `starting`, and `playing` phases.
- Add monotonically increasing playback epochs.
- Assign the first valid queue entry when idle.
- Permit WebRTC offers only from the assigned broadcaster.
- Route answers and ICE candidates only for expected connections.
- Advance on validated `playback:ended`.

### Browser

- Allow any participant to construct the existing Web Audio output graph.
- When assigned, resolve the queue entry to its retained local `File`.
- Decode just in time and create one outgoing peer connection per listener.
- Give non-broadcasters one incoming live-audio slot.
- Close old media connections at every epoch boundary.
- Keep local monitor behavior for the broadcaster.

### Acceptance

A queues song A, B queues song B, and C listens. A broadcasts to B and C. At the end, connections move to B and song B starts. Network inspection confirms no MP3 or live audio passes through Fly.io.

## Phase 3: owner-independent survival

### Work

- Ensure owner disconnect does not mutate playback or queue.
- Advance immediately when the current broadcaster disconnects.
- Remove disconnected participants' waiting entries.
- Add preparation timeout and duration watchdog.
- Add owner skip/remove controls that work after owner reconnects with the private URL.
- Make idle and recovery states explicit in the UI.

### Acceptance

A creates the room; B and C enqueue tracks. While B is playing, A closes their browser. B finishes and C starts. If B closes mid-song, C is promoted without recreating the room.

## Phase 4: reliability and diagnostics

### Work

- Preserve ICE path, bitrate, RTT, and timeout diagnostics across rotating peers.
- Add connection counts for the active broadcaster.
- Exercise Chrome, Firefox, and mobile Safari where available.
- Test home Wi-Fi, separate residential networks, and mobile data.
- Run repeated queue boundaries and a 30-minute room.
- Record how often direct STUN-only connectivity fails before deciding on TURN.

### Acceptance

- Three or more participants complete ten queue transitions.
- Queue state remains consistent after joins and leaves.
- A single listener failure does not stop the room.
- Error messages identify whose song failed and what Panster did next.
- No tab grows memory without bound across repeated songs.

## Phase 5: deployment-state decision

Only after the single-machine shared queue works:

- Decide whether Fly restarts must preserve room identity.
- Decide whether more than one Fly machine is necessary.
- Introduce PostgreSQL or another shared coordinator only for demonstrated needs.
- Remember that persisted metadata cannot restore local source files after every participant disconnects.

## Migration notes

### Reuse

- Hono WebSocket signaling transport
- Room codes and owner capability URLs
- WebRTC diagnostics
- Web Audio source, monitor, and media-destination graph
- Direct fanout and connection timeout behavior
- Security headers, room limits, and tests

### Isolate or retire

- Permanent `dj` role
- Creator-centered peer topology
- Two-deck/crossfader UI
- Automatic placement of contributed files into host decks
- MP3 DataChannel transfer as a required playback path

Keep removed prototype behavior in Git history rather than maintaining two competing room modes.

## Test strategy

### Unit/server tests

- Queue validation and fairness invariant
- Owner-independent disconnect behavior
- Epoch rejection for stale messages
- Assignment and advancement
- Watchdog behavior using controllable time
- Signaling authorization for current broadcaster

### Browser tests

Use generated short MP3 fixtures and real Chromium pages to verify:

1. Metadata extraction and fallback
2. Shared queue synchronization
3. Broadcaster A fanout
4. Hard handoff to broadcaster B
5. Creator departure
6. Current broadcaster failure
7. Late listener connection
8. Repeated transitions and memory behavior

The media-plane Chromium test remains the release gate; mocked WebRTC tests alone are insufficient.
