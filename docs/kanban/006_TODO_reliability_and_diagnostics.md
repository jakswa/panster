# Prove reliability and improve diagnostics

- **Status:** TODO
- **Type:** Ticket
- **Depends on:** [001](archive/001_DONE_shared_queue_and_rotating_broadcaster.md)

## Outcome

Demonstrate that the rotating-broadcaster queue survives repeated handoffs across supported browsers and real networks, while giving people useful explanations when a direct connection fails.

## Work

- Preserve ICE path, bitrate, RTT, and timeout diagnostics across rotating peers.
- Add connection counts for the active broadcaster.
- Exercise Chrome, Firefox, and mobile Safari where available.
- Test home Wi-Fi, separate residential networks, and mobile data.
- Run repeated queue boundaries and a 30-minute room.
- Record how often direct STUN-only connectivity fails before deciding on TURN.
- Check for unbounded tab memory growth across repeated songs.

## Acceptance criteria

- Three or more participants complete ten queue transitions.
- Queue state remains consistent after joins and leaves.
- A single listener failure does not stop the room.
- Error messages identify whose song failed and what Panster did next.
- No tab grows memory without bound across repeated songs.
- Results record browsers, network paths, failures, and whether TURN would have changed the outcome.