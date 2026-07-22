# Album artwork

- **Status:** TODO
- **Type:** Epic
- **Depends on:** [006](006_TODO_reliability_and_diagnostics.md) for production rollout; embedded-cover work may proceed independently

## Product decision

Panster should automatically show and share album artwork for a queued song when artwork is available.

Artwork is part of the room presentation, not private crate-only metadata. Choosing a song already causes its audio and queue metadata to be shared with the room; requiring a second consent step for its cover would add friction without creating a meaningful privacy boundary. The UI should still work when no trustworthy image can be found.

This feature does not send MP3 bytes to the Panster server. It sends only a small, normalized image derivative. The original embedded image remains in the owner's browser.

## Source order

Use the first successful source in this order:

1. Embedded ID3v2 `APIC` or ID3v2.2 `PIC` artwork, preferring a front-cover image.
2. A cached lookup previously resolved for the same local track or release.
3. MusicBrainz release matching followed by the Cover Art Archive.
4. Panster's generated placeholder.

Embedded artwork is authoritative enough for automatic display. A lookup result is best-effort: title, artist, and album text can be incomplete or ambiguous, so a weak match must fall back to the placeholder rather than showing a confidently wrong cover.

MusicBrainz and the Cover Art Archive are the preferred open infrastructure. Their APIs and metadata are open, but that does not imply that every cover image is freely licensed for arbitrary reuse. Panster displays artwork in connection with the identified release and should not describe or package retrieved images as freely licensed assets.

Commercial catalogs such as Spotify, Apple, Discogs, and Last.fm must not be foundational dependencies. Their authentication, caching, attribution, and image-use terms can change independently of Panster. They may be evaluated later only with an explicit terms and availability review.

## Embedded artwork extraction

Artwork extraction happens in the song owner's browser while text metadata is read.

The parser must:

- Read the ID3 header first, then read only the bounded tag range needed for frames. The current fixed prefix read is not sufficient because a valid picture frame may occur after it.
- Support `APIC` and `PIC` frames without attempting to support every ID3 feature.
- Prefer picture type `3` (front cover), then the first decodable image.
- Check both the declared MIME type and image signature.
- Reject SVG, animated formats, unknown formats, malformed images, and unreasonable encoded or decoded dimensions.
- Bound input bytes before decoding so a hostile local file cannot create unbounded memory use.

The original picture is never sent directly. Decode it in the browser, correct orientation where the browser exposes it, draw it onto a canvas, and encode a fresh derivative. This strips unrelated image metadata and gives every shared image predictable dimensions and size.

Initial derivative limits:

- At most `256 × 256` pixels
- Square output, using a centered crop suitable for album covers
- WebP when supported, JPEG otherwise
- At most 32 KiB after encoding
- No animation or ancillary metadata

If the image cannot fit after reducing quality, extraction fails and Panster tries the lookup fallback.

## Sharing model

Artwork should appear for all room participants, including people who join after the song was queued. It therefore cannot depend only on the audio connection, which is created when the song reaches the front.

Use a bounded artwork message over the existing room WebSocket path:

1. The queue entry is accepted and receives its server queue-entry ID.
2. The owner sends the normalized derivative associated with that ID.
3. The server validates the entry ownership, declared media type, encoded length, and decoded envelope where practical.
4. The server retains the derivative only in the in-memory room entry and includes an artwork reference in room snapshots.
5. Clients fetch or receive the derivative lazily for visible queue rows and now-playing state.
6. Removing the entry or expiring the room removes its artwork.

Binary WebSocket frames or a small room-scoped asset endpoint are preferable to embedding base64 in every JSON snapshot. The exact transport may follow the simplest implementation, but it must preserve the same size, authorization, lifetime, and rate limits.

This is deliberately different from audio transport. A maximum 32 KiB derivative is inexpensive room presentation state; an MP3 or live audio stream remains peer-to-peer and never passes through or persists on the application server.

The server must never accept an arbitrary remote image URL from a participant and fetch it. That would create an SSRF and abuse surface. It accepts only normalized image bytes, or a lookup identifier handled by a narrowly scoped lookup implementation.

## Open lookup fallback

When no usable embedded cover exists, use MusicBrainz and the Cover Art Archive as a best-effort fallback.

Preferred matching signals, strongest first:

1. A MusicBrainz release or release-group identifier already present in tags.
2. Album plus album artist/artist, with normalized exact agreement.
3. Track title plus artist plus album and duration, with a conservative score threshold.

Prefer release-group front artwork when several editions are equivalent for display. Do not choose solely from a fuzzy title search. If candidates are tied or below the confidence threshold, show the generated placeholder.

The lookup implementation must:

- Identify Panster appropriately to MusicBrainz and obey published rate limits.
- Deduplicate concurrent requests and cache positive and negative results.
- Treat `404`, throttling, provider downtime, and CORS failure as ordinary fallback conditions.
- Avoid placing API keys in browser code. MusicBrainz and Cover Art Archive do not require a secret key for this use.
- Never use a general-purpose server-side URL proxy.
- Fetch a provider thumbnail rather than an original image where available, then pass it through the same decode and normalization pipeline as embedded artwork.

A server-side metadata lookup can provide consistent rate limiting and caching, while the image still goes through a constrained Cover Art Archive host allowlist and normalization. A browser-only lookup is also feasible, but exposes the participant's network address to the providers and makes shared caching weaker. The implementation should prefer the narrow server-side lookup, not a generic proxy.

Acoustic fingerprinting with Chromaprint and AcoustID may be considered later for files with poor tags. It is not the first fallback: browser fingerprinting adds CPU and download weight, and submitting a fingerprint discloses information about the selected recording to another service.

## Local crate integration

The crate may cache:

- The normalized derivative
- Its source (`embedded`, `cover-art-archive`, or `generated`)
- A MusicBrainz release or release-group identifier
- Lookup time and negative-cache expiry

Artwork should be referenced from track/catalog state rather than duplicated in every playlist item. Queueing a crate track uses the cached derivative when valid and shares it through the same room path as one-time file selection.

Portable crate exports may include normalized embedded derivatives and identifiers. Remotely retrieved artwork should only be included if its source terms permit that use; otherwise export the identifier and resolve it again after import.

## Failure and UI behavior

Artwork is decorative and must never block queueing or playback.

- Render the stable generated placeholder immediately.
- Replace it when embedded extraction or lookup succeeds.
- Do not shift queue layout when artwork arrives.
- Keep text title and artist visible; artwork is not a metadata substitute.
- If an owner disconnects, normal queue removal also removes the artwork.
- If lookup fails, do not repeatedly retry during every render or reconnect.
- A participant may disable remote artwork loading as an accessibility or reduced-data preference; embedded derivatives already present in room state are not considered remote third-party loads.

## Security and resource limits

Treat artwork and its metadata as untrusted input.

- Apply a dedicated per-entry byte limit before allocation and decoding.
- Apply per-participant artwork message rate limits separately from SDP/ICE signaling.
- Authorize updates against the queue-entry owner and reject updates after removal.
- Allow only the supported raster MIME types and verify signatures.
- Serve bytes with an exact `Content-Type`, `X-Content-Type-Options: nosniff`, and a restrictive content security policy.
- Do not preserve filenames, EXIF, comments, ICC payloads, or embedded URLs in the derivative.
- Revoke object URLs when rows disappear or artwork changes.
- Include worst-case artwork memory in room and process capacity planning.

## Delivery stages

### Stage 1: embedded covers

- Extend metadata parsing for bounded `APIC`/`PIC` extraction.
- Normalize covers in a worker where practical.
- Add the bounded room transport and late-join behavior.
- Display artwork in queue rows and now-playing state.

### Stage 2: open lookup

- Add MusicBrainz matching and Cover Art Archive retrieval.
- Add conservative confidence rules, caching, and provider rate limiting.
- Normalize lookup images through the same pipeline.

### Stage 3: crate reuse

- Persist derivatives and release identifiers in the local crate.
- Deduplicate artwork records shared by multiple tracks from one release.
- Define export behavior according to source terms.

## Acceptance criteria

- A tagged MP3 with a normal front cover shows the same cover to existing and late-joining participants without sending the MP3 to the server.
- Oversized, malformed, animated, SVG, and mislabeled embedded images safely fall back without blocking queueing.
- The application server accepts no more than the configured derivative limit for one entry and releases it with the room entry.
- A song with no embedded cover can resolve a high-confidence MusicBrainz/Cover Art Archive match.
- Ambiguous and unavailable lookups show the stable generated placeholder.
- Artwork failure never interrupts signaling, queue progression, or audio playback.
