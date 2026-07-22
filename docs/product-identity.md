# Product identity

## One-sentence promise

Panster is a small peer-to-peer listening room where friends add local MP3s to one shared queue. When a song reaches the front, its owner's browser broadcasts it directly to the room.

A shorter description is **passing the aux automatically**.

## Core experience

1. Someone creates a room and shares its guest link.
2. A guest enters a display name and presses **Enter room**, satisfying browser audio requirements.
3. They immediately hear the current song, if any.
4. They choose a local MP3 and preview its detected metadata.
5. They correct the title or artist if necessary and add it to the shared queue.
6. When the song reaches the front, that guest's browser becomes the temporary broadcaster.
7. The song plays from start to finish.
8. Panster advances to the next available song and changes broadcasters.

The creator may leave without ending the room. Their private owner link grants moderation, not a permanent media role.

## Product defaults

- One shared first-in, first-out queue
- At most one waiting song per participant, in addition to their currently playing song
- One current broadcaster
- One complete song per queue entry
- Clear stop followed by clear start; no crossfade
- Local files never upload to the Panster web server
- Queue entries disappear when their owning browser leaves
- The owner may skip the current song or remove a queue entry
- The room remains alive while participants are connected and expires after inactivity

One waiting song per participant keeps the room social, limits browser memory, and prevents one person from filling the queue. As soon as a participant's song starts, they may add one more behind it. A sole contributor can therefore keep the room going without filling the queue in advance; normal FIFO order still applies when friends add songs.

## What the queue displays

MP3 metadata can make the queue substantially better than raw filenames.

Each queue row should contain:

- Track title
- Artist, when available
- Duration
- Submitted-by display name
- Position or **Up next** status
- Readiness state when relevant

The now-playing card should use the same information with elapsed and remaining time.

### Metadata extraction

Metadata remains client-side. Panster should read:

- ID3 title
- ID3 artist
- ID3 album, retained for future use
- Browser-detected duration

Text metadata is sent through room signaling; MP3 bytes are not.

Use a small browser-compatible ID3 parser rather than implementing the full tag format from scratch. Duration can come from a temporary local media element or audio decode. The implementation should avoid decoding every queued file into an `AudioBuffer` long before its turn.

### Fallbacks

When metadata is absent:

1. Strip the file extension.
2. Replace repeated underscores and separators with spaces where reasonable.
3. Use the cleaned filename as the title.
4. Display **Unknown artist** subtly rather than making it visually dominant.

Before enqueueing, let the user edit title and artist. Treat all metadata as untrusted text, cap field lengths, and render it escaped or through `textContent`.

### Artwork

Album artwork is deferred. Sending embedded artwork to every participant adds payload, validation, and privacy complexity. The initial UI can generate a stable color or simple record icon from the queue-entry ID.

## Roles

### Owner

Possesses the private room capability URL. May skip songs and remove queue entries. The owner can leave and return without affecting playback.

### Participant

Listens, chooses a display name, and may add one local song to the queue.

### Current broadcaster

The participant whose queue entry is now playing. Their browser temporarily fans one WebRTC audio stream out to the other participants.

There is no permanent DJ role in the media architecture.

## Explicit non-goals

The first shared-queue release does not attempt:

- Crossfading
- Beatmatching or tempo synchronization
- Simultaneous decks
- Crowd-controlled mixing
- Synchronized playback across nearby speakers
- Permanent music uploads
- Accounts or server-hosted personal libraries
- Recovery of a song after its broadcaster disappears
- Multiple Fly.io application instances
- TURN fallback
- AI selection or sequencing

These may be built later only if the shared queue is reliable and enjoyable.

## Future extensions that fit the identity

- An optional device-local crate with OPFS-backed tracks and multiple playlists
- Portable playlist and crate exports, followed later by user-approved device transfer
- Reactions and lightweight voting
- Configurable queue fairness
- An Auto-DJ participant that fills an empty queue
- Audience requests
- Durable room history
- Rich metadata and artwork
- Optional transitions between already-reliable queue entries
