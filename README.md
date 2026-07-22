# Panster

A small peer-to-peer listening room where friends add local MP3s to one shared queue. When a song reaches the front, its owner's browser broadcasts it directly to everyone else.

**A room, a queue, everyone gets a turn.**

## Run

```sh
bun install
bun run dev
```

Open <http://localhost:3000>, start a room, and share its guest link. Every participant chooses a display name and presses **Enter room** to unlock browser audio.

Panster does not need PostgreSQL, accounts, or server-side music storage.

## Try the shared queue

1. Start a room and copy its room link.
2. Open that link in another browser or device.
3. Enter a name on each page.
4. Choose an MP3. Panster reads its ID3 title and artist locally; edit them if needed.
5. Press **Add to queue**.
6. When the song reaches the front, its owner's browser broadcasts it directly to the room.
7. Add another participant's song and confirm playback moves to their browser at the song boundary.
8. Close the creator's tab and confirm the queue continues.

A participant may keep one song waiting while their current song plays. If nobody adds another, playback stops and the room remains open with an empty queue.

## Architecture

```text
                         ┌── listener A
current song owner ──────┼── listener B
                         └── listener C
       Web Audio              WebRTC audio

Bun + Hono
  ├─ room membership and shared FIFO queue
  ├─ current-broadcaster assignment and playback epochs
  └─ WebSocket signaling
```

The current song's source MP3 remains in its owner's tab. The Fly/Hono server receives text metadata and WebRTC signaling, but never receives MP3 bytes or live audio.

At each song boundary, the next entry's owner becomes the broadcaster. Consecutive songs from the same owner reuse the existing media connections. The room creator holds a private moderation capability but is not permanent media infrastructure and may leave without ending playback.

See the [`docs/` kanban](docs/README.md) for active product work, archived decisions, and the planned [device-local crate and playlist system](docs/kanban/008_TODO_local_crate_and_playlists.md).

## Hosting

Panster is designed to run as one process. The included Fly.io configuration limits the app to one machine because room state and WebSocket peers are currently process-local.

For a local Caddy deployment:

```caddy
panster.home.jake.town {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy or Fly handles HTTPS and WebSocket upgrades. Panster uses Google's public stateless STUN service to discover direct peer paths; it does not currently have a TURN fallback.

```sh
bun run app:build
NODE_ENV=production ASSET_VERSION=$(git rev-parse --short HEAD) bun run start:prod
```

## Scripts

```sh
bun run dev
bun run typecheck
bun test
bun run app:build
bun run build       # typecheck, tests, and production build
```

## Current boundaries

- Twelve participants per room with direct broadcaster-to-listener fanout.
- One waiting song per participant, in addition to their currently playing song.
- MP3 only, with a 150 MB and four-hour per-track limit.
- Client-side ID3 title, artist, and album extraction; artwork is deferred.
- Hard song boundaries with no crossfade or beatmatching.
- Rooms and queues disappear on process restart.
- Rooms expire after 24 hours of inactivity; the process holds at most 1,000 rooms.
- Room creation and per-socket messages are rate-limited.
- Public STUN is configured, but no TURN relay is configured.
- A current song cannot survive its owner's tab closing; Panster advances to the next entry.
- Mobile/background tab suspension is not yet handled reliably.
- Nearby listener devices are not synchronized speakers.

PostgreSQL, server-hosted libraries, album artwork, reactions, voting, AI sequencing, and richer transitions remain out of scope until the shared queue is solid with real rooms. An optional OPFS-backed local crate with rich playlists and portable exports is planned without changing Panster's no-upload model.

## License

[MIT](LICENSE)
