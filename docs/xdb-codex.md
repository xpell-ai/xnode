# xnode Codex — XDB Refactor Contract

This codex defines **hard rules** and **working conventions** for refactoring and extending XDB inside the **xnode (xpell-node)** project.

---

## 1. Scope Rules (Hard)

- ❌ Do NOT change xpell-core, runtime, CLI, or other modules
- ❌ Do NOT introduce new dependencies outside what XDB already uses
- ✅ Changes must compile and preserve existing behavior

---

## 2. Xpell Object Model Rules

### 2.1 XModule Ownership
- `XDB` is an `XModule`
- All XDB-related `XObject`s MUST be:
  - registered via `XDB.importObject(...)`
  - created via `XDB.create(...)`
- ❌ Never instantiate XDB objects using `new` outside unavoidable base classes

### 2.2 Valid Object Creation Pattern
```ts
XDB.importObject(XDBVector._xtype, XDBVector);

const vec = XDB.create({
  _type: XDBVector._xtype,
  _xdb_entity_id,
  _xdb_entity_name
});
```

---

## 3. Constructor Rules for XDB Objects

### 3.1 Constructors
- Constructors MUST accept only:
```ts
constructor(data: XObjectData)
```

- ❌ Do NOT pass `engine` or storage to constructors
- ❌ Do NOT perform filesystem or storage work in constructors
- ✅ Constructors may only:
  - call `super`
  - `parse(data)`
  - assign metadata fields

### 3.2 Engine Access
- XDB objects MUST access the engine via:
```ts
XDB._engine
```

- All engine usage MUST:
  - assume async initialization
  - guard against uninitialized engine

---

## 4. Engine Readiness Contract

- XDB engine is async-initialized
- XDB module MUST fire `"xdb-ready"` event when ready
- XDB objects MUST NOT silently operate if engine is not ready

### Recommended helper:
```ts
function assertXdbReady() {
  if (!XDB._engine || !XDB._engine._initialized) {
    throw new Error("XDB engine is not ready");
  }
}
```

---

## 5. Storage Abstraction Rules

- XDBEngine is storage-agnostic
- All persistence goes through `IXDBStorage`
- ❌ No XObject may directly access:
  - filesystem
  - database drivers
  - `_storage` internals

- If an XObject needs a capability:
  - add a public method to `XDBEngine`
  - delegate internally to storage

---

## 6. Helper Objects (Vector / File / Temp)

### 6.1 Ownership
- `XDBVector`, `XDBFile`, `XDBTemp` are helper XObjects
- They are:
  - owned by XDB module
  - associated with a single entity
  - created lazily or in entity constructor via `XDB.create`

### 6.2 Responsibilities
| Object | Responsibility |
|------|----------------|
| XDBVector | Vector storage, indexing, binary handling |
| XDBFile | Persistent entity files |
| XDBTemp | Temporary, transactional files |

---

## 7. Behavioral Compatibility

- Preserve:
  - data formats
  - vector scaling
  - file layout semantics
  - entity meta structure
- Refactors must be **mechanical**, not conceptual

---

## 8. Anti-Patterns (Forbidden)

❌ `new XDBVector(...)`  
❌ `engine._storage.*` outside XDBEngine  
❌ Creating folders inside XObject constructors  
❌ Cross-module imports outside `/src/XDB`  
❌ Silent failures when engine is not ready  

---

## 9. Intent

XDB is designed to be:
- Embedded
- Deterministic
- Storage-agnostic
- Xpell-native

This codex ensures XDB remains a **first-class runtime system**, not a utility blob.

---

**Single Source of Truth:**  
All XDB behavior must be explainable by reading `/src/XDB` alone.
