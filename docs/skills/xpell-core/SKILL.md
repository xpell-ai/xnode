---
name: xpell-core
description: Foundational runtime contract for @xpell/core. Use for Xpell core coding, architecture, Codex prompts, repo review, or debugging involving XpellEngine, XModule, XObject, XData, XDataModule, XEventManager, XCommand, XParser, Nano-Commands v2, runtime accessor injection, and platform-neutral runtime behavior.
---

# Xpell Core Contract

Apply this contract when generating, reviewing, or modifying code that depends on `@xpell/core`.

Requires:

- `xpell-contract`

## 1. Applies to / Scope

This contract applies to `@xpell/core` and code that depends directly on core runtime behavior.

It also guides integration layers built on top of core:

- `@xpell/ui`
- `@xpell/node`
- `@xpell/3d`
- Xpell apps and product repos

## 2. Core Identity

`@xpell/core` is a platform-neutral runtime/interpreter core.

It provides:

- engine loop and scheduler: `XpellEngine.onFrame`, `start`
- command dispatch: `run`, `execute`
- shared runtime memory: `XData` / `_xd`
- standard `xd` command bridge module over XData
- runtime accessor injection: `setXRuntime` / `getXRuntime`
- event bus: `XEventManager` / `_xem`
- base extension/object model: `XModule`, `XObject`, `XObjectManager`
- command parsing and command envelopes: `XParser`, `XCommand`
- protocol/error primitives: `XError`, `XResponse*`

It is not:

- a UI renderer
- a DOM layer
- a Node/server layer
- a persistence/database layer
- an app/business framework
- a hidden-state runtime

Code reality caveat:

- `XParser.xmlString2Xpell()` uses `DOMParser`; this helper requires an environment that provides `DOMParser`.

## 3. Runtime Accessor Contract

Core primitives such as `XObject` must not import the engine singleton directly.

Use runtime injection:

- `setXRuntime(runtime)`
- `getXRuntime()`

Rules:

- `XpellEngine` registers itself through `setXRuntime(this)`.
- `XObject` may call `getXRuntime()` only when routing module commands.
- Do not import `_x` or `Xpell` directly inside `XObject`.
- Do not use dynamic `import("./Xpell")` inside `XObject`.
- Runtime injection prevents circular imports between `Xpell` and `XObject`.

## 4. Runtime Invariants

Single source of truth:

- Engine module registry inside `_x` is authoritative for module command routing.
- Runtime shared data keys live in `XData`.
- Object-level behavior lives on `XObject` instances.

Execute path:

- `_x.run("...")` → `XParser.parse(...)` → `_x.execute(xcmd)`.
- `_x.execute(xcmd)` requires `xcmd._module` and a loaded module.
- `XModule.execute(xcmd)` dispatches:
  - if `xcmd._object` exists: to that object’s `XObject.execute(...)`
  - otherwise to module method `"_" + _op.replaceAll("-", "_")`
- Missing module ops must throw or return a structured error at the appropriate boundary.
- `XObject.execute(xcmd)` first tries local nano-command execution.
- If no local nano command exists and `_module` is present, `XObject.execute(...)` routes through `getXRuntime().execute(...)`.

Loop/state:

- Engine increments the frame.
- Engine calls each module `onFrame`.
- Engine writes:
  - `engine:frame-number`
  - `engine:fps`
- Legacy keys `frame-number` / `fps` may be written only when `_compat_legacy_keys` is true.

Events:

- Event coordination uses `_xem`: `on`, `once`, `fire`, `remove`, `removeOwner`.
- `XObject` event handlers are parsed once on mount and cleaned on dispose.

Serialization:

- `XObject.toXData()` drops function fields.
- `XResponse.toXData()` returns a transport-safe response envelope.

## 5. XData Contract

`XData` / `_xd` is shared runtime memory.

Canonical API:

- `get`
- `set`
- `patch`
- `touch`
- `has`
- `delete`
- `pick`
- `on`
- `off`
- `onAny`
- `clean`

Rules:

- XData is runtime memory only.
- XData is not persistence.
- XData is not an event bus.
- Every mutation must include stable `source` metadata.
- Keys must be explicit, stable, and namespaced.
- Do not mirror XData into hidden mutable shadow state.
- New code must not write via `_xd._o[...]`.
- `_o` may exist only for legacy compatibility and migration.

Example:

```ts
_xd.set("ui:status", "ready", { source: "example" });
```
6. XData Command Bridge Module

XData / _xd must remain pure runtime memory and must not extend XModule.

Core may expose XDataModule as a thin command bridge.

Canonical module name:

{
  "_module": "xd",
  "_op": "set",
  "_params": {
    "key": "ui:status",
    "value": "ready",
    "source": "example"
  }
}

Allowed common ops:
	•	get
	•	set
	•	patch
	•	delete
	•	touch
	•	has
	•	pick

Rules:
	•	XDataModule is only a bridge to _xd.
	•	XDataModule owns no independent state.
	•	XDataModule does not persist data.
	•	Mutating ops must include stable source.
	•	xd commands must use explicit keys.
	•	xd commands must not infer missing state.
	•	xd must not be used as an event bus.

7. Nano-Commands v2 Contract

Handlers may be used from:
	•	object lifecycle hooks: _on_create, _on_mount, _on_data, _on_frame
	•	event maps: _on, _once
	•	UI declarations
	•	persisted JSON views
	•	agent-editable payloads

Allowed handler forms:

String nano-command:

"set-text text:Hello"

JSON local command:

{
  "_op": "set-text",
  "_params": {
    "text": "Hello"
  }
}

JSON module command:

{
  "_module": "xd",
  "_op": "set",
  "_params": {
    "key": "form:email",
    "value": "test@example.com",
    "source": "login_form"
  }
}

Sequence:

[
  {
    "_module": "xd",
    "_op": "set",
    "_params": {
      "key": "ui:clicked",
      "value": true,
      "source": "button"
    }
  },
  {
    "_op": "set-text",
    "_params": {
      "text": "Clicked"
    }
  }
]

Rules:
	•	Handlers stored in DB/files or generated by agents must be data-only.
	•	No JS functions in persisted or agent-editable payloads.
	•	No eval.
	•	No function strings.
	•	Unknown ops must be rejected at validation boundaries.
	•	Nano commands without _module are local object-scoped commands.
	•	Commands with _module are routed through getXRuntime().execute(...).
	•	Local nano commands keep priority over _module routing for backward compatibility.
	•	Module-routed commands must include _module and _op.

8. XObject Command Execution Contract

XObject.execute(...) supports two execution paths:
	1.	local nano command
	2.	module-routed command

Execution priority:
	1.	local nano command
	2.	_module routing
	3.	error/log missing command

Local nano command:

{
  "_op": "set-text",
  "_params": {
    "text": "Hello"
  }
}

Module command from object handler:

{
  "_module": "xd",
  "_op": "set",
  "_params": {
    "key": "form:email",
    "value": "test@example.com",
    "source": "login_form"
  }
}

Rules:
	•	XObject must not import _x or Xpell directly.
	•	XObject must use getXRuntime() for module routing.
	•	Existing nano-command behavior must remain backward compatible unless explicitly changed.
	•	If _module exists but a local nano command with the same _op exists, the local nano command wins.
	•	_object may be forwarded for explicit object-targeted module commands.

9. XEM Contract

_xem is a lightweight event bus.

Rules:
	•	Events are coordination only.
	•	Events are not state.
	•	Events are not persistence.
	•	Listener order must not be assumed.
	•	Payloads must be explicit.
	•	Listener exceptions are caught and logged; dispatch continues.
	•	Use XData for state.
	•	Use _xem for signals.

10. XModule Contract

XModule is the base extension point for behavior.

Rules:
	•	Every module must have a unique _name.
	•	Command exposure is through underscore-prefixed methods.
	•	Command "my-op" maps to method "_my_op".
	•	Objects are created and owned through the module’s XObjectManager.
	•	Object-targeted commands require explicit _object.
	•	Modules must not mutate other modules directly.

Cross-module behavior must go through:
	•	_x.execute(...)
	•	_xem
	•	documented XData keys

11. XObject Contract

XObject is the base runtime node.

Rules:
	•	XObject is UI-agnostic.
	•	XObject must not include or assume:
	•	DOM
	•	CSS
	•	show / hide
	•	layout
	•	browser APIs
	•	server APIs
	•	filesystem APIs
	•	UI behavior belongs in @xpell/ui.
	•	Server behavior belongs in @xpell/node.
	•	3D/spatial behavior belongs in @xpell/3d.

Lifecycle hooks:
	•	onCreate
	•	onMount
	•	onData
	•	onFrame
	•	dispose

Data-source binding:
	•	_data_source binds through _xd.on(...).
	•	Data delivery is subscription-based, not frame polling.
	•	dispose() must unbind data listeners and event listeners.

12. Error and Logging Contract

Rules:
	•	Prefer structured errors where transport-facing boundaries exist.
	•	Use XError / XResponse* for protocol-facing failures.
	•	Avoid raw exceptions across transport boundaries.
	•	_xlog has no automatic secret redaction guarantee.
	•	Never log secrets, tokens, credentials, auth headers, or private keys.

13. Hard Forbiddens
	•	Do not add UI behavior to @xpell/core base classes.
	•	Do not use XData as an event bus.
	•	Do not use events as state.
	•	Do not use XData as persistence.
	•	Do not write new code through _xd._o[...].
	•	Do not rely on listener ordering.
	•	Do not use eval or executable strings in persisted payloads.
	•	Do not import Xpell / _x directly inside XObject.
	•	Do not create hidden cross-module mutation paths.
	•	Do not couple core to Node FS or browser DOM APIs.
	•	Do not introduce hidden timers, polling loops, or background schedulers in core.

14. Output Discipline

When generating or editing core-dependent code:
	•	Do not infer missing runtime state.
	•	Use explicit keys and params.
	•	Prefer small, auditable changes.
	•	Keep runtime behavior deterministic.
	•	Add logging/instrumentation only where useful.
	•	Do not add background loops unless explicitly allowed by a layer contract.
	•	Preserve backward compatibility unless explicitly asked to break it.
	•	If docs and source disagree, follow source code and record the mismatch.

