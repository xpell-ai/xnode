# Wormholes v2 — Server Side (xnode)

## Purpose
Wormholes is the realtime transport layer between **xpell-ui** clients and **xnode**.
It supports WebSocket and REST using a single canonical envelope.

## Server Responsibilities
- Validate envelope shape
- Enforce `_kind` semantics
- Execute REQ via `_x.execute()`
- Return RES with `_rid`
- Emit EVT to clients
- Maintain `_sid` session state

## Envelope Rules
- JSON only
- `_kind` is UPPERCASE
- `_rid` REQUIRED on RES
- `_sid` REQUIRED after AUTH

## Execution Flow
REQ -> XCmd -> `_x.execute()` -> XResponseData -> RES

## REST Notes
- REST MAY accept REQ/RES only
- HELLO/AUTH MAY be HTTP endpoints
- `_wid` may be request-scoped

## Forbidden (Server)
- Mutating payload shapes
- Returning lowercase `_kind`
- Silent RES without `_rid`
