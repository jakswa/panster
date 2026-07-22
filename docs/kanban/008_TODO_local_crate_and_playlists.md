# Local crate and playlists

- **Status:** TODO
- **Type:** Epic
- **Depends on:** [006](006_TODO_reliability_and_diagnostics.md)

## Product promise

Panster should let someone choose music once, organize it richly, and queue it in future rooms without repeatedly reopening the file picker.

The feature is called **Your crate**:

> Music kept privately in this browser. Nothing is uploaded to Panster.

The crate is optional. A participant can always choose one MP3 for the current room without setting up storage.

## Product boundaries

- MP3 bytes remain on the participant's device.
- Importing creates a second, browser-managed copy; it does not move or alter the original file.
- The crate belongs to one browser profile and one Panster origin.
- Clearing site data, private-browsing cleanup, browser eviction, or changing domains can remove it.
- A crate is not automatically synchronized to another browser or device.
- Room queues remain ephemeral and server-authoritative.
- Local playlists are private organization, not shared room queues.
- OPFS persistence does not make shared rooms work without the network. A service worker would be separate offline-app work.

## Experience modes

Panster must preserve three useful levels of capability.

### 1. One-time selection

This is the current baseline and must remain available everywhere.

- Choose an MP3.
- Keep its `File` in memory for the current tab.
- Queue and broadcast it normally.
- Reloading requires choosing it again.

No storage setup, persistent permission, or library commitment is required.

### 2. Local crate

When Origin Private File System storage is available:

- Import songs or a folder.
- Copy each unique MP3 into OPFS.
- Store searchable metadata and playlists locally.
- Queue from the crate after reloads and browser restarts.
- Show storage durability and usage honestly.

### 3. Prepared but unavailable

If OPFS, quota, or persistence is unavailable, the crate UI should not become a broken control surface.

- Explain the benefit before requesting anything.
- Keep **Choose an MP3 for this room** prominent.
- Explain whether storage is unsupported, full, temporary, or denied.
- Offer a retry and practical browser-setting guidance when useful.
- Never block room entry, listening, or one-time queueing.
- Avoid repeatedly nagging after a user declines.

## Permission and preparation UX

OPFS itself normally does not show a user-facing filesystem permission prompt. The explicit file picker grants access to source files, after which Panster copies them into origin-private storage. The browser may separately decide whether storage can be made persistent.

Panster should sell the value before asking:

> **Keep your music ready**
>
> Import songs once, make playlists, and queue them in future rooms. They stay in this browser and never upload to Panster.

Actions:

- **Set up my crate**
- **Not now — choose one song**

After setup:

1. Check `navigator.storage.persisted()`.
2. Request durability with `navigator.storage.persist()` from a clear user action.
3. Check capacity with `navigator.storage.estimate()`.
4. Explain the resulting state without claiming guarantees the browser did not provide.

Suggested states:

- **Stored persistently** — the browser granted durable storage.
- **Stored on this device** — available now, but the browser may reclaim it under storage pressure.
- **Storage nearly full** — imports remain possible only within the estimated capacity.
- **Crate unavailable** — continue with one-time file selection.

A denied persistence request is not fatal. Panster can still offer the crate with an eviction warning, unless writes actually fail.

## User experience

### Crate home

The crate should support:

- Search across title, artist, album, and filename
- Sort by title, artist, album, duration, date added, or most recently played
- Filter by playlist, artist, album, or storage/readiness state
- Recently added and recently played views
- Track count, total duration, and storage used
- Compact and comfortable display densities
- Multi-select with clear keyboard and touch behavior
- Queue action from every track row
- Metadata editing without changing the original MP3
- Reveal technical details such as source filename, size, and import date on demand

### Playlist management

Users may create any reasonable number of playlists. A playlist contains ordered references to crate tracks, never copied MP3 bytes.

Support:

- Create, rename, duplicate, and delete playlists
- Optional description and stable generated color
- Add one or many selected tracks
- Remove tracks without deleting them from the crate
- Reorder using drag, keyboard controls, and explicit move actions
- Copy or move selected entries between playlists
- Sort a playlist into a new order with undo
- Allow a track in multiple playlists at no storage cost
- Allow deliberate repeated entries inside one playlist
- Show track count and total duration
- Queue the next eligible track from a playlist
- Preserve the room's one-waiting-song fairness rule; a playlist cannot bulk-fill the room queue

Deleting a playlist must never delete its tracks. Deleting a crate track should show every playlist affected and require confirmation when references exist.

### Import

Import entry points:

- **Choose songs** using a multiple-file picker
- **Choose a folder** where browser support permits
- Drag and drop on desktop
- **Keep this song in my crate** after a one-time selection
- Import a Panster backup or playlist manifest

The import flow should:

1. Preflight estimated capacity.
2. Show files discovered, accepted, duplicated, unsupported, and failed.
3. Copy in the background with per-file and overall progress.
4. Allow cancellation between files.
5. Parse metadata client-side.
6. Write to a temporary OPFS path first.
7. Commit the catalog record only after the file is safely closed.
8. Clean abandoned temporary files on the next startup.
9. Report partial success instead of rolling back an entire large import.

Folder access is an import convenience, not a permanent dependency. After copying, Panster should not require the original folder handle.

### Export and backup

Export is part of trustworthy local storage, not an afterthought.

#### Playlist manifest

A small Panster JSON document containing:

- Format and schema version
- Playlist identity, name, description, and order
- Track metadata
- Content hashes and sizes
- Optional provider identifiers added in the future

A manifest does not contain audio. Importing it matches tracks already in the crate and clearly lists missing music to reconnect.

#### Portable playlist bundle

A user-requested archive containing:

- The playlist manifest
- One copy of each unique referenced MP3
- Optional M3U8 for interoperability

If a song appears repeatedly or in several exported playlists, include its bytes once and reference it many times. Build large exports as streams where browser APIs permit rather than buffering the entire archive in memory.

#### Full crate backup

An explicit, potentially large export of catalog metadata, playlists, and unique media objects. Show estimated size and warn about mobile download limitations before beginning.

#### Individual recovery

Allow downloading an individual stored MP3. This reinforces that the crate belongs to the user and provides an escape hatch from browser-managed storage.

### Import and merge behavior

When importing a manifest or bundle:

- Validate schema, paths, sizes, and hashes before trusting records.
- Never overwrite unrelated local records silently.
- Deduplicate media by content hash.
- Merge an identical track into the existing catalog.
- Resolve playlist-name conflicts with **Replace**, **Keep both**, or **Merge**.
- Explain missing and corrupt files.
- Preserve unknown forward-compatible metadata when safe.

## Storage architecture

Use OPFS for audio bytes and IndexedDB for structured catalog state.

```text
Origin Private File System
  /tracks/{media-object-id}.mp3
  /imports/{temporary-id}.part

IndexedDB
  mediaObjects
  tracks
  playlists
  playlistItems
  settings
  migrations
```

### Media object

Represents one unique byte sequence:

```text
id
contentHash
opfsPath
size
mimeType
createdAt
integrityState
```

### Track

Represents the user's catalog identity and editable metadata:

```text
id
mediaObjectId
title
artist
album
durationSeconds
originalFilename
importedAt
lastPlayedAt
playCount
metadataSource
```

Separating tracks from media objects leaves room for metadata variants while guaranteeing that playlist organization never duplicates MP3 bytes.

### Playlist

```text
id
name
description
colorSeed
createdAt
updatedAt
```

### Playlist item

```text
id
playlistId
trackId
position
addedAt
```

Playlist item identity is separate from track identity so one track may intentionally appear more than once.

## Deduplication

The same MP3 imported repeatedly or included in several bundles should occupy one OPFS media object.

Preferred identity is a SHA-256 content hash calculated incrementally in a worker while copying the source into a temporary OPFS file. After hashing:

- If the hash is new, move or commit the temporary file as a media object.
- If it already exists with the same size, discard the temporary copy and reuse the existing object.
- If integrity metadata conflicts, retain neither assumption silently; verify and report the anomaly.

Do not load a 150 MB file into memory solely to hash it. If an incremental hashing implementation is deferred, use size and lightweight fingerprinting only as a duplicate candidate, then verify before deleting bytes.

Garbage collection removes a media object only when no track references it. Playlist removal alone never affects media objects.

## Playback integration

A room queue entry continues to contain only validated metadata, owner peer ID, local track ID, duration, and size.

When a crate track reaches the front:

1. Resolve its track record in IndexedDB.
2. Resolve and integrity-check its OPFS media object.
3. Obtain a `File` from the OPFS handle.
4. Feed it into the same local playback and WebRTC broadcast path as a one-time selection.
5. If it is missing or unreadable, report `playback:failed` and let the room advance.

The first implementation may retain `arrayBuffer()` plus `decodeAudioData()`, matching current behavior. A later media-element source can reduce full-file decode cost and improve start time for large files.

## Quota, eviction, and integrity

At startup and before large imports:

- Read `navigator.storage.estimate()`.
- Display usage and quota as estimates, not promises.
- Verify catalog schema and complete pending migrations.
- Clean stale files under `/imports`.
- Sample or lazily verify that referenced OPFS files still exist.
- Mark missing tracks as unavailable rather than deleting playlist entries immediately.

On `QuotaExceededError`:

- Stop the current file safely.
- Remove its temporary file.
- Preserve completed imports.
- Show the additional space requested and current estimate.
- Offer crate cleanup and one-time selection.

The crate should include a storage manager showing largest tracks, unreferenced metadata, durability status, and a destructive **Clear crate** action.

## Multiple tabs and migrations

Two Panster tabs may share one OPFS and IndexedDB database.

- Use Web Locks where available to serialize imports, destructive cleanup, and schema migrations.
- Use `BroadcastChannel` to refresh catalog views across tabs.
- Keep queue-specific `File` and playback state isolated per tab.
- Make migrations versioned, resumable, and safe after interruption.
- Never deploy a migration that requires all MP3 bytes to fit in memory.

## Privacy and security

OPFS is private from other origins, not from Panster code running on the same origin. A future cross-site scripting bug could expose local catalog data, so the current strict CSP, escaped rendering, dependency discipline, and no-third-party-script posture remain important.

- Never send audio bytes, filenames, hashes, playlists, or catalog contents to the server by default.
- Send only the metadata required for an explicitly queued room entry.
- Do not add analytics over personal library contents.
- Treat imported tags, manifests, archive paths, and filenames as untrusted.
- Cap archive expansion, entry count, field lengths, and total declared size.
- Require explicit confirmation for crate-wide deletion.

## Browser and capability strategy

Progressively detect rather than infer from user agent:

- `navigator.storage.getDirectory`
- `navigator.storage.estimate`
- `navigator.storage.persisted`
- `navigator.storage.persist`
- Multiple-file input
- Directory input/drop support
- Web Locks and BroadcastChannel
- Streaming archive support

The minimum supported experience remains one-time MP3 selection. A browser failing any crate capability should still be a complete room participant.

Test at minimum:

- Chromium desktop
- Chromium Android
- Safari desktop
- Safari on iPhone/iPad
- Firefox desktop
- Private-browsing behavior where practical
- Low-quota and forced-write-failure simulations

## Moving and syncing between browsers

Cross-device sync is a later stretch goal, but today's format should prepare for it.

### Near-term transfer

Portable crate and playlist bundles provide a transparent, account-free migration path between machines.

### Direct device transfer

A future **Move from another device** flow could pair two Panster browsers with a short code or QR code, exchange an end-to-end encrypted connection, compare content hashes, and transfer only missing media objects. Both devices would need to be online simultaneously; the Panster server would coordinate but not retain audio bytes.

### Optional durable sync

True background sync would require durable identity and some storage provider. Possible directions include user-owned cloud storage or encrypted object storage, but this changes Panster's privacy, cost, account, recovery, and abuse model. It should not be smuggled into the OPFS implementation.

Stable IDs, versioned manifests, content hashes, and byte deduplication should be designed now so that later transfer does not require rebuilding the crate model.

## Delivery plan

### Phase C1: storage foundation

- Capability detection and prepared/unavailable UX
- Persistence and quota status
- OPFS media-object repository
- IndexedDB schema and migrations
- Atomic multi-file import
- One-time-selection fallback
- Storage manager and clear-crate flow

### Phase C2: rich crate

- Search, sort, filters, recent views, and metadata editing
- Multi-select and bulk actions
- Queue from crate
- Duplicate detection and integrity states
- Cross-tab coordination
- Mobile and low-storage hardening

### Phase C3: playlists

- Multiple playlists and full CRUD
- Ordered playlist items and repeated entries
- Drag, keyboard, touch, copy, and move organization
- Playlist totals and queue-next behavior
- Reference-aware track deletion

### Phase C4: portability

- Versioned manifest import/export
- Portable playlist bundles with byte deduplication
- Full crate backup and individual MP3 recovery
- Conflict, merge, missing-track, and corrupt-bundle UX

### Phase C5: later transfer experiments

- Direct paired browser transfer
- Hash-based delta copying
- Evaluate encrypted user-owned or hosted sync only after real demand

## Acceptance criteria

- A user imports music once, reloads, and queues it without another picker.
- The same song can appear in many playlists while only one MP3 copy exists.
- Playlist edits never mutate room queues or delete source bytes unexpectedly.
- A browser without OPFS can still listen and contribute via one-time selection.
- Denied persistence and exhausted quota produce useful, recoverable states.
- Clearing or evicting a file marks affected tracks and playlists honestly.
- Exports can reconstruct playlist order and include each unique MP3 once.
- No MP3 bytes leave the browser except through an explicit room broadcast, export, or future user-approved device transfer.
