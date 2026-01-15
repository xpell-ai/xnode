# XDB v1

**XDB v1** is a storage-agnostic, embedded database engine designed for the **Xpell runtime**.

It provides **entity-based data management**, optional **vector & semantic support**, and **pluggable persistence**, while keeping all core logic deterministic and in-memory.

---

## Goals

XDB v1 is designed to:

- Be **runtime-embedded** (not a standalone server)
- Support **real-time entity creation**
- Separate **engine logic** from **storage**
- Enable **AI / vector workflows** without hard dependencies
- Integrate cleanly with **XModule / XObject**

---

## Architecture

```
┌─────────────┐
│  XDBEngine  │  ← Core logic (filters, vectors, semantic ops)
└─────┬───────┘
      │
┌─────▼─────────────────────┐
│        IXDBStorage         │  ← Persistence contract
│  (FS / SQLite / Mongo…)    │
└─────┬─────────────────────┘
      │
┌─────▼──────────┐
│   XDBEntity    │  ← Dynamic entities
│   XDBVector    │
│   XDBFile      │
│   XDBTemp      │
└────────────────┘
```

---

## Core Concepts

### XDBEngine
- Owns **query logic**, **vector handling**, and **semantic search**
- Does **not** know how data is persisted
- Uses injected providers for:
  - Embeddings
  - Vector search (MAT / ANN / external engines)

### IXDBStorage
Pluggable storage adapter.

Examples:
- `XDBStorageFS` (filesystem)
- `XDBStorageSqlite` (embedded production storage)
- Future: Mongo, Graph, Remote

### XDBEntity
- Schema-driven dynamic entities
- Created at runtime
- Fully managed via Xpell’s `XObjectManager`

---

## Embeddings & Vectors

XDB v1 does **not** hard-code any AI provider.

Embedding and vector search are injected via:

- `IXDBEmbeddingProvider`
- `IXDBVectorQueryProvider`

This allows:
- OpenAI / Azure / local models
- Text, image, or custom embeddings
- Offline or internal vector engines

---

## Versioning

This is **XDB v1**.

Guarantees:
- Stable contracts
- No breaking changes inside v1.x
- Storage adapters remain compatible

Breaking architectural changes will result in **XDB v2**.

---

## Non-Goals (by design)

XDB v1 is **not**:
- A distributed database
- A graph database
- A SQL replacement
- A standalone service

Those are future versions.

---

## Status

**Production-ready (v1)**  
Actively evolving inside the Xpell ecosystem.
