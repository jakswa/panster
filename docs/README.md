# Panster planning

These documents describe the next product direction beyond the current media-plane prototype.

## Core decision

Panster is a small peer-to-peer listening room where friends add local MP3s to one shared queue. When a song reaches the front, its owner's browser broadcasts it directly to everyone else.

There is no permanent media host. The room creator is a moderator, not infrastructure. Songs have clear starts and ends; transitions are hard handoffs with no crossfade in the first implementation.

## Documents

- [Product identity](product-identity.md) — promise, user experience, scope, and metadata presentation
- [Room state machine](room-state-machine.md) — server-authoritative queue and playback lifecycle
- [Rotating media topology](rotating-media-topology.md) — WebRTC connections and broadcaster handoff
- [Failure and recovery](failure-and-recovery.md) — expected behavior when browsers and networks fail
- [Implementation plan](implementation-plan.md) — incremental work and acceptance criteria

## Status

This is a plan, not the behavior of the current prototype. The prototype still uses the creator's DJ browser as the permanent media hub and supports P2P MP3 contribution to that hub.
