# Panster

A media-plane-first prototype for browser-based P2P DJ rooms.

A guest sends an MP3 directly to the DJ over a WebRTC data channel. The DJ browser decodes it into a two-deck Web Audio graph, mixes it, and broadcasts the live output to guests as a WebRTC audio track.

## Run

```sh
bun install
bun run dev
```

Open <http://localhost:3000>, create a room, and copy the guest link into another browser or device. The prototype does not need PostgreSQL or authentication.

For testing across devices, serve Panster over HTTPS. WebRTC and Web Audio work on `localhost`, but browser security restrictions apply to non-localhost origins.

## First end-to-end test

1. Create a room in the DJ browser.
2. Press **Start DJ engine**. This user gesture unlocks Web Audio and joins signaling.
3. Open the guest link in another browser.
4. On the DJ, load an MP3 into deck A and play it.
5. Confirm the live mix reaches the guest audio control.
6. On the guest, choose an MP3 and press **Send to DJ**.
7. Confirm it appears in the DJ's empty deck, play it, and move the crossfader.

For a useful fanout test, open a second guest and confirm both receive the same mix.

## Current architecture

```text
guest MP3
    │ WebRTC DataChannel, 32 KiB chunks
    ▼
DJ browser
    ├─ complete-file buffering + decodeAudioData()
    ├─ AudioBufferSourceNode decks A/B
    ├─ equal-power GainNode crossfader
    └─ MediaStreamAudioDestinationNode
             │ WebRTC live audio (normally Opus)
             ▼
         guest browsers

Bun + Hono: HTTP pages, assets, and WebSocket signaling
```

Rooms and peer rosters are in memory and disappear when the server restarts. Each room gets an unguessable DJ token that stays in the private DJ URL; copied guest links omit it. The server enforces that token on both the room page and signaling socket.

The server relays only WebRTC signaling; MP3 bytes and live audio do not pass through the Hono server.

## Hosting behind Caddy

```caddy
panster.home.jake.town {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy handles HTTPS and WebSocket upgrades. Panster uses Google's public stateless STUN service to discover direct peer paths; it does not currently have a TURN fallback.

```sh
bun run app:build
NODE_ENV=production ASSET_VERSION=$(git rev-parse --short HEAD) bun run start:prod
```

## Scripts

```sh
bun run dev        # Tailwind watcher + Bun server watcher
bun run typecheck
bun test           # HTTP surface and live WebSocket relay tests
bun run app:build
```

## Prototype constraints

- Twelve peers per room, with direct DJ-to-guest fanout.
- Rooms expire after 24 hours of inactivity; the process holds at most 1,000 rooms.
- Room creation and per-socket signaling are rate-limited, and duplicate peer IDs are rejected.
- One active track transfer per guest connection, with a 150 MB track limit and a 200 MB aggregate DJ receive reservation.
- The DJ validates metadata, chunk sizes, and actual bytes received before decoding.
- MP3 files are transferred completely before decoding; this is not incremental MP3 decode.
- A transferred track fills deck A when empty, otherwise deck B.
- Public STUN is configured, but no TURN server is configured yet.
- A 15-second timeout identifies failed direct paths and explains when TURN is likely needed.
- The diagnostics panel shows the selected ICE candidate types, transport, media bitrate, and RTT.
- The DJ tab must remain active; mobile/background suspension is not handled.
- Listener jitter buffers are not synchronized tightly enough for nearby devices acting as a speaker array.
- DJ capability is protected by an in-memory token, but guest rooms remain link-accessible and there are no accounts.

## Immediate next experiments

1. Deploy behind HTTPS and test desktop Chrome/Firefox over LAN.
2. Test home internet to mobile data and capture the reported ICE paths.
3. Run a 30-minute mix with two listeners and several guest transfers.
4. Collect real failures before deciding whether to add coturn.
5. Only then decide between direct fanout, an SFU, or synchronized local playback.

AI track planning, BPM analysis, beat grids, persistent libraries, and accounts are intentionally out of scope until this media path proves itself.

## License

[MIT](LICENSE)
