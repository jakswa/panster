# Panster kanban

This directory is the planning board. One Markdown file represents one ticket or epic.

## Filename contract

```text
NNN_STATUS_short_slug.md
```

- `NNN` is a stable, three-digit ID. Assign the next unused number and never recycle one.
- `STATUS` makes board state visible in a directory listing.
- `short_slug` describes the outcome in lowercase snake case.
- Move a ticket with `git mv` when its status changes; keep its ID and slug.

## Workflow

| Status | Meaning | Location |
|---|---|---|
| `TODO` | Ready or queued | `docs/kanban/` |
| `DOING` | Actively being implemented | `docs/kanban/` |
| `BLOCKED` | Cannot advance until its stated dependency clears | `docs/kanban/` |
| `DONE` | Acceptance criteria met | `docs/kanban/archive/` |
| `INVALID` | Rejected, superseded, or no longer wanted | `docs/kanban/archive/` |

Only active work belongs on the visible board. `DONE` and `INVALID` files remain searchable in Git without crowding current priorities.

## Ticket shape

Every ticket starts with these fields:

```markdown
# Outcome-oriented title

- **Status:** TODO
- **Type:** Ticket | Epic
- **Depends on:** ticket IDs or None

## Outcome

## Scope

## Acceptance criteria
```

Large design detail may live in an epic, but status, dependencies, scope boundaries, and acceptance criteria must remain obvious near the top or in clearly labeled sections.

## Active board

| ID | Status | Type | Work |
|---|---|---|---|
| [006](006_TODO_reliability_and_diagnostics.md) | TODO | Ticket | Reliability and diagnostics |
| [007](007_TODO_album_artwork.md) | TODO | Epic | Album artwork |
| [008](008_TODO_local_crate_and_playlists.md) | TODO | Epic | Local crate and playlists |
| [009](009_TODO_deployment_state_decision.md) | TODO | Ticket | Deployment-state decision |
