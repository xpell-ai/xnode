# XNODE CODEX — STRICT SYSTEM CONTRACT (Xpell 2)

This document defines the **NON-NEGOTIABLE rules** for generating code in the **xnode** project (Xpell Node server runtime).

Violations are incorrect output.

---

## 0. Scope

**xnode** is a **server runtime + services** layer built on top of `@xpell/core`.

It provides:
- deterministic server bootstrap (Express HTTP/HTTPS)
- persistence and settings (explicit, inspectable)
- Wormholes v2 (REST + WS) as the real-time boundary
- optional static hosting for web clients (served from a work folder)

It must remain a **library** that host applications can configure (routes, settings, modules).

---

## 1. Core Principles

- Xpell is a **real-time interpreter**, not a framework.
- Everything must be **explicit and inspectable**.
- **No hidden magic**, no auto-inference, no auto-repair.
- **No background autonomous behavior** (no timers/polling for “fixing” state).

---

## 2. Object Model (MANDATORY)

All runtime-managed objects extend `XObject`.

Rules:
- Every runtime-managed property **MUST** start with `_`
- Runtime fields **MUST** be `snake_case`
- No public mutable fields without `_`
- Methods may use camelCase

Examples:
- ✅ `_status`, `_work_folder`, `_public_folder`
- ❌ `status`, `workFolder`

If encapsulation is needed:
- use `private` fields
- expose state via underscore-prefixed properties

---

## 3. Methods, Commands, and Exposure

- Methods starting with `_` are public to the engine and may be invoked via `XCommand`.
- Methods without `_` are internal-only.
- Mapping rules:
  - leading `_` removed
  - `_` and `-` are interchangeable
  - no other transformations

Example: `_install_wormholes_v2` callable as `install_wormholes_v2` or `install-wormholes-v2`.

---

## 4. XData2 (Shared Runtime State) — STRICT

XData2 is **shared runtime memory**, **NOT persistence** and **NOT an event bus**.

Canonical API only:
- Read: `_xd.get(key)`
- Write: `_xd.set(key, value, { source })`
- Delete: `_xd.delete(key, { source })`
- Subscribe: `_xd.on(key, cb)`
- Touch: `_xd.touch(key, { source })`

Rules:
- Every `set/delete/touch` MUST include a stable `source` string.
- Do **NOT** mirror XData2 into hidden local state.
- Do **NOT** use XData2 as a transport layer between server and client (use Wormholes).
- Legacy `_xd._o[...]` is **FORBIDDEN** for new xnode code.

---

## 5. Events (XEventManager)

- Use `_xem` for events.
- Do not assume listener order.
- Events are **not state**.
- Payloads must be explicit objects (prefer underscore fields).

---

## 6. Settings (XSettings / _xs) — Deterministic

- Settings are explicit and live under the **work folder**.
- Host apps may override settings explicitly.
- No silent defaults beyond documented `DEFAULT_*` objects.
- Never “guess” missing settings—seed them explicitly on first-run only.

Recommended pattern:
- `onSetup(work_folder)` seeds defaults + creates required files/folders.
- `init(work_folder)` loads existing settings.

If settings update requires restart:
- log explicitly and deterministically (no auto-restart).

---

## 7. Persistence & Storage

- Persistence is **NOT XData2**.
- xnode may provide deterministic storage adapters (MongoDB/SQLite/files), but:
  - schemas must be explicit
  - CRUD must be deterministic
  - serialization must be explicit (no magic field transforms)

---

## 8. HTTP/HTTPS Server Contract (Express)

xnode may use Express as an implementation detail.

Rules:
- Do not hard-code application routes in a library.
- Server must support **host-defined routing** via explicit APIs.
- Avoid wildcard SPA fallbacks that can break Wormholes REST routes.
- Middlewares must be installed deterministically (ordered, explicit).

### Static Hosting
- Static files live under `work_folder/public` (or equivalent).
- Hosting path should be explicit (e.g., `/public`).
- Default “home” route is optional and must be opt-in or explicitly applied **only when declared** (no inference).

---

## 9. Wormholes v2 — Boundary Contract (MANDATORY)

Wormholes is the **only** real-time communication boundary.

Rules:
- Use Wormholes v2 envelope protocol only.
- Do not expose raw WebSocket/fetch protocols to host code unless explicitly part of Wormholes implementation.
- REST router must be installed before generic fallbacks.
- WS server must attach to the actual HTTP/HTTPS server instance.

Security flags must be explicit:
- `_require_auth` must default to false only for dev/testing and be configurable.
- no implicit auth logic.

---

## 10. Routing Extensibility (LIBRARY RULE)

Because xnode is a library, host applications must control routes.

Required mechanism:
- Code-based installer: `useRoutes((app, server) => { ... })`
- Optional config-based routes (simple home/static/json routes)
- Deterministic precedence:
  1) host code routes
  2) config routes
  3) default home (only if explicitly not set)
  4) safe fallback

Forbidden:
- detecting existing routes by inspecting Express internals
- “smart” route inference
- global wildcard SPA fallback that steals `/wh/*`

---

## 11. Security (Baseline)

- Never log secrets (keys/tokens).
- Do not trust `req.body` without validation.
- CORS must be explicit and configurable.
- If SSL is enabled:
  - enforce HTTPS explicitly
  - SSL file paths must be explicit settings fields
- Any SUPER user or admin bypass must be explicit and off by default.

---

## 12. TypeScript & Build Rules

- ESM by default (`import`/`export`), no `require`.
- `tsconfig` should use a modern module resolution strategy (NodeNext/Bundler) matching the ESM ecosystem.
- Public API surface must be explicit:
  - `exports` in `package.json` must reflect actual build outputs
  - never rely on implicit deep imports
- Avoid circular dependencies across modules.

---

## 13. Forbidden Patterns

- Hard-coded magic strings (use constants)
- “if kind === x” architecture traps (use explicit capability registration)
- inferred state, scanning filesystem to guess configuration
- timers/polling to “fix” or “sync” state
- hidden persistence

---

## 14. Required Output Format for Codex

When generating changes:
1) Brief summary of what is being changed and why (2–6 bullets)
2) Implementation plan (ordered steps)
3) Code changes (only if explicitly requested to print)
4) Verification checklist (commands + expected results)

If the user says they will review in VS Code:
- do **NOT** print full files; provide only the plan + checklist.

---

## 15. Verification Checklist (Minimum)

- Server starts deterministically (HTTP/HTTPS as configured)
- Wormholes REST routes still respond (no fallback interception)
- WS connects on `/wh/v2`
- Host can define `/` and other routes via `useRoutes`
- Settings seeding occurs only on first run
- No `setInterval`/`setTimeout` introduced
- All runtime state fields use underscore + snake_case

---

## Final Rule

If unsure — STOP and ask (or choose the safest deterministic behavior).
