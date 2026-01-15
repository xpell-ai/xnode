# Wormholes v2 — Server Side (xnode)

## Purpose
Wormholes is the **canonical transport protocol** for Xpell runtimes.

## Supported Transports
- WebSocket (primary)
- REST (REQ/RES only)

## Envelope Rules
- JSON only
- `_kind` is UPPERCASE
- REQ / RES correlation via `_rid`
- AUTH establishes `_sid`

## Lifecycle (WS)
1. Client connects
2. HELLO
3. AUTH (optional)
4. REQ / EVT / PING
5. RES / EVT / PONG

## Gateway Responsibilities
- Parse envelope
- Validate session
- Route REQ to `_x.execute()`
- Emit EVT to `_xem`
- Return XResponseData

## Forbidden
- JSON-in-JSON
- Hidden mutations
- Transport-specific logic in modules
