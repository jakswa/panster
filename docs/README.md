# Panster planning

These documents describe Panster's shared-queue product direction and the work growing out of the original media-plane prototype.

## Core decision

Panster is a small peer-to-peer listening room where friends add local MP3s to one shared queue. When a song reaches the front, its owner's browser broadcasts it directly to everyone else.

There is no permanent media host. The room creator is a moderator, not infrastructure. Songs have clear starts and ends; transitions are hard handoffs with no crossfade in the first implementation.

## Documents

- [Product identity](product-identity.md) — promise, user experience, scope, and metadata presentation
- [Room state machine](room-state-machine.md) — server-authoritative queue and playback lifecycle
- [Rotating media topology](rotating-media-topology.md) — WebRTC connections and broadcaster handoff
- [Failure and recovery](failure-and-recovery.md) — expected behavior when browsers and networks fail
- [Local crate and playlists](local-crate-and-playlists.md) — OPFS storage, rich playlist management, portability, and graceful fallback
- [Implementation plan](implementation-plan.md) — incremental work and acceptance criteria

## Status

The initial shared-queue experience is implemented: client-side metadata, one waiting song per participant, rotating WebRTC broadcasters, hard handoffs, playback epochs, owner-independent rooms, and failure timeouts. Reliability work across more browsers and real networks remains ongoing.
