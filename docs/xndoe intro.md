# Xpell-Node — Introduction

Xpell-Node is the **server-side runtime** of the Xpell ecosystem.

It provides:
- A Node.js execution environment for Xpell modules
- A unified command execution layer (`_x.execute`)
- Wormholes v2 (WebSocket + REST) for real-time client/server communication
- A foundation for AI agents, dashboards, automation, and games

This document introduces the core ideas and how everything fits together.

---

## What is Xpell-Node?

Xpell-Node is **not** a web framework.

It is a **runtime engine** that:
- Loads Xpell modules
- Executes commands deterministically
- Exposes those commands over Wormholes (WS / REST)
- Manages sessions, auth, and routing
- Can run headless, embedded, or as a standalone service

Think of it as:
> *An operating system for structured, real-time AI and UI logic.*

---

## Core Responsibilities

### 1. Runtime Engine
- Hosts the Xpell core interpreter
- Manages modules, objects, and commands
- Enforces strict execution rules (no hidden state, no inference)

### 2. Command Execution
All external requests eventually become:
```ts
_x.execute({
  _module: "module-name",
  _op: "operation",
  _params: { ... }
})
```

This applies equally to:
- REST calls
- WebSocket (Wormholes) messages
- Internal module calls

---

### 3. Wormholes v2 (Transport Layer)

Wormholes is the **only supported transport** for real-time communication.

Supported modes:
- WebSocket (primary)
- REST (REQ / RES only)

Wormholes provides:
- Session management (`_sid`)
- Connection identity (`_wid`)
- REQ / RES correlation
- EVT (server → client events)

> Wormholes is **protocol-first**, not framework-driven.

---

## High-Level Architecture

```
Client (xpell-ui)
   |
   |  Wormholes v2 (WS / REST)
   v
Xpell-Node Gateway
   |
   |  _x.execute(...)
   v
Xpell Core Runtime
   |
   |  Modules / Objects / Agents
   v
Application Logic
```

---

## Execution Model

- No background threads
- No hidden timers
- No magic side effects
- Everything is explicit and traceable

All state changes happen through:
- XData
- Command execution
- Explicit events

---

## Session & Identity

Xpell-Node distinguishes between:

- **Connection** (`_wid`)
  - Transport-level identity
  - One per WebSocket connection or REST request

- **Session** (`_sid`)
  - Logical authenticated session
  - May span reconnects

- **Routing identity**
  - `_node`, `_agent`, `_client`
  - Used for multi-node / multi-agent setups

---

## REST vs WebSocket

### WebSocket (Preferred)
- Full Wormholes protocol
- HELLO / AUTH / REQ / RES / EVT / PING / PONG
- Real-time, bidirectional

### REST
- REQ → RES only
- No EVT
- Same envelope format
- Same command execution

---

## What Xpell-Node is NOT

❌ Not Express with helpers  
❌ Not MVC  
❌ Not ORM-driven  
❌ Not event-loop magic  
❌ Not framework glue  

Xpell-Node is deliberately **minimal and strict**.

---

## Typical Use Cases

- Admin dashboards (xpell-ui)
- AI agents and orchestrators
- Real-time monitoring systems
- Multiplayer game logic
- Automation backends
- Headless AI services

---

## Philosophy

- Determinism over convenience
- Protocols over frameworks
- Explicit state over inferred state
- Long-term maintainability over shortcuts

---

## Next Steps

- Read `docs/wormholes.md`
- Read `docs/codex.md`
- Explore `xnode/src/wormholes`
- Build your first module and expose it via Wormholes

---

> If something feels implicit — it’s probably wrong.
