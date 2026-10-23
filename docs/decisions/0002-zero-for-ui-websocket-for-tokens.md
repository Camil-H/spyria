# 0002. Zero syncs UI state; agent tokens stream over a WebSocket

## Context

Members expect the app to react instantly and to show each other's changes live: new messages, renamed chats, role changes, unread counts. Agents produce a different kind of data: a stream of small text chunks, many per second, that only matters while the answer is being written, read by the few people looking at that chat right now. Writing each chunk to Postgres would put every token through the write-ahead log, logical replication, zero-cache and every client's replica.

## Decision

- UI state syncs through Rocicorp Zero. Each browser holds a local replica of the rows it may see; writes are Zero mutators that apply optimistically in the browser and authoritatively on the server. zero-cache replicates Postgres and asks the server which rows each member may read.
- Agent tokens never go through Zero. The server forwards them to the browsers watching a chat over a WebSocket (`/api/stream`), after checking that each viewer may read the chat.
- Only completed items (a finished text segment, a tool step, a question, the end of the turn) are written to Postgres, and from there reach every viewer through Zero.

## Consequences

- The UI is fast without hand-written caching, and collaboration needs no extra code.
- Replication carries only meaningful rows; token chatter never touches the write-ahead log.
- Two channels to reason about while a turn runs: the live stream for in-progress text and Zero for everything stored. A viewer joining mid-turn gets a snapshot of the text so far, then the live chunks.
- A slow viewer is disconnected and reconnects rather than making the server buffer without limit.

## Alternatives considered

- Electric: its hosted offering was winding down.
- Server round trips with htmx-style rendering: slower for the user and a poor fit for the collaborative views.
- Streaming tokens through the synced store: high-frequency writes would load replication for every client.
