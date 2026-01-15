# Xpell-Node — Architecture

## Overview
Xpell-Node is the **authoritative server runtime** of the Xpell ecosystem.
It executes commands, manages state, exposes Wormholes endpoints, and enforces protocol rules.

## Core Invariants
- Single source of truth: `_x.execute()`
- No UI assumptions
- No framework coupling
- Transport-agnostic (WS / REST)
- Deterministic execution

## Main Components
- **Xpell Engine** – runtime loop & command dispatcher
- **Modules** – isolated behavior units
- **Wormholes v2** – transport/session protocol
- **XDB** – optional data + vector layer

## Data Flow (High Level)
Client → Wormholes → Gateway → `_x.execute()` → Module → XResponse → Client

## What Xpell-Node Is NOT
- Not Express-first
- Not MVC
- Not REST-only
- Not a web framework

It is a **runtime + protocol engine**.
