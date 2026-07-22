# Failure and recovery

The first queue release favors understandable recovery over seamless recovery.

| Failure | Expected behavior |
|---|---|
| Room owner leaves | Room and playback continue unchanged |
| Listener leaves | Current broadcaster closes that listener's peer connection |
| Queued participant leaves | Remove their queued entry and update positions |
| Current broadcaster leaves | Current song stops; assign the next available entry |
| Broadcaster fails to decode | Remove the entry, explain the failure to its owner, and advance |
| Broadcaster cannot establish any listeners | Time out the start, remove or return the entry, and advance |
| One listener cannot connect | Other listeners continue; affected listener sees direct-connection diagnostics |
| Next participant's tab is suspended | Start timeout fires and Panster skips that entry |
| Browser omits or lies about `ended` | Duration watchdog stops the current epoch |
| Owner presses skip | Stop current epoch and advance immediately |
| Queue becomes empty | Room remains connected and displays **Add a song** |
| Fly.io process restarts | Room and queue are lost in the initial architecture |
| Two Fly.io machines handle one room | Unsupported until shared state and connection routing exist |

## User-facing language

Failures should describe what Panster is doing rather than expose protocol jargon.

Good examples:

- **Connecting to Maya's browser…**
- **Maya's song could not start, so we skipped it.**
- **The current DJ disconnected. Starting the next song…**
- **We could not make a direct connection on this network.**
- **The queue is empty. Add something from your computer.**

ICE details remain available in the diagnostics panel for troubleshooting.

## Timeouts

Initial values should be constants and instrumented rather than scattered through UI code.

- Broadcaster preparation: 30 seconds
- Listener connection wait before starting: 2 seconds
- Playback watchdog grace: 15 seconds beyond declared duration
- Signaling heartbeat failure: approximately 10–15 seconds
- Empty-room retention: follow the existing room inactivity policy

Tune these using real sessions rather than attempting seamless behavior immediately.

## Queue cleanup

The source `File` exists only in its owner's live page. Therefore:

- A reload invalidates that participant's queued entry unless explicit resume support is later built.
- A WebSocket reconnect within the same live page may retain it if participant identity can be resumed safely.
- A server restart cannot restore playable queued entries even if metadata is persisted, because the source files are gone.

The UI should never imply that a queued local song is durable.

## Abuse boundaries

Retain the prototype's limits and apply equivalent validation to queue messages:

- Room and signaling rate limits
- Maximum participants
- Duplicate connection-ID rejection
- Bounded metadata fields
- Plausible duration bounds
- One queued entry per participant
- Server-authoritative assignment and epoch checks

Because normal queue playback does not transfer MP3 files, the current incoming-file memory risk leaves the primary path. If DataChannel contribution remains available experimentally, its existing size and aggregate-memory checks must remain.
