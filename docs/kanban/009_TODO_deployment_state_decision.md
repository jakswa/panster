# Decide the deployment-state boundary

- **Status:** TODO
- **Type:** Ticket
- **Depends on:** [006](006_TODO_reliability_and_diagnostics.md)

## Outcome

Use observed reliability and deployment needs to decide whether Panster should remain a single-process, in-memory application or gain durable/shared coordination.

## Questions

- Must a Fly restart preserve room identity?
- Is more than one Fly machine necessary?
- Which room metadata, if any, is valuable after a process restart?
- Does the operational value justify PostgreSQL or another coordinator?

Persisted metadata cannot restore local source files after every participant disconnects. WebRTC peers must renegotiate after a process restart even if room metadata survives.

## Acceptance criteria

- The decision cites observed failures or concrete operating requirements rather than hypothetical scale.
- The chosen boundary documents room identity, queue metadata, reconnect behavior, and multi-machine routing.
- If persistence is rejected, the ticket records the evidence threshold that would reopen the decision.
- If persistence is accepted, follow-up implementation tickets define the smallest useful state model.