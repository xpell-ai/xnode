---
name: Xpell Core Contract
id: xpell-core
version: "1.1.0"
updated: "2026-04-30"
description: "Foundational runtime contract for @xpell/core: deterministic interpreter, XData2 shared state, XData command bridge, runtime accessor injection, Nano-Commands v2, XEM event bus, and module/object base classes."
requires:
  - xpell-contract
---

## 1) Scope

Applies to `@xpell/core` and all layers built on top of it:

- `@xpell/ui`
- `@xpell/node`
- `@xpell/3d`
- Xpell apps and product repos

Use this contract when generating, reviewing, or modifying code that depends on core runtime behavior.

## 2) Core identity

`@xpell/core` is the platform-neutral runtime foundation.

It provides:

- `XpellEngine` / `_x`
- `XModule`
- `XObject`
- `XObjectManager`
- `XData` / `_xd`
- `XEventManager`
- `XCommand`
- `XParser`
- Nano-Commands v2
- protocol/error primitives

It is NOT:

- a UI renderer
- a DOM layer
- a Node/server layer
- a persistence layer
- an app/business framework

## 3) Runtime accessor rule

Core primitives such as `XObject` MUST NOT import the engine singleton directly.

Use runtime injection:

- `setXRuntime(runtime)`
- `getXRuntime()`

Rules:

- `XpellEngine` registers itself through `setXRuntime(this)`.
- `XObject` may call `getXRuntime()` only for `_module` command routing.
- Do not import `_x` or `Xpell` inside `XObject`.
- Do not use dynamic `import("./Xpell")` inside `XObject`.

## 4) XData2 rules

`XData` / `_xd` is shared runtime memory.

Rules:

- XData is NOT persistence.
- XData is NOT an event bus.
- Use canonical APIs: `get`, `set`, `patch`, `touch`, `has`, `delete`, `pick`, `on`, `off`, `onAny`, `clean`.
- Every mutation must include stable `source` metadata.
- Keys must be explicit, stable, and namespaced.
- New code MUST NOT write through `_xd._o[...]`.
- `_o` may exist only for legacy compatibility and migration.

## 5) XData command bridge

`XData` MUST remain pure runtime memory and MUST NOT extend `XModule`.

Core may expose `XDataModule` as a thin command bridge.

Canonical module name:

```json
{
  "_module": "xd",
  "_op": "set",
  "_params": {
    "key": "ui:status",
    "value": "ready",
    "source": "example"
  }
}

Allowed ops:
	•	get
	•	set
	•	patch
	•	delete
	•	touch
	•	has
	•	pick

Rules:
	•	XDataModule owns no independent state.
	•	XDataModule does not persist data.
	•	Mutating ops must include stable source.
	•	xd commands must use explicit keys.
	•	xd must not infer missing state.
	•	xd must not be used as an event bus.

6) XObject command execution

XObject.execute(...) supports:
	1.	local nano-command execution
	2.	module-routed command execution

Execution priority:

1. local nano command
2. _module routing
3. error

Rules:
	•	Nano commands without _module are object-scoped.
	•	Commands with _module are routed through getXRuntime().execute(...).
	•	Local nano commands keep priority over _module routing for backward compatibility.
	•	XObject MUST NOT import _x or Xpell directly.
	•	_object may be forwarded for explicit object-targeted module commands.

7) Nano-Commands v2

Handlers may be used from:
	•	_on_create
	•	_on_mount
	•	_on_data
	•	_on_frame
	•	_on
	•	_once
	•	persisted JSON views
	•	agent-editable payloads

Allowed data-only forms:
	•	string nano-command
	•	JSON local command: { "_op": "...", "_params": {} }
	•	JSON module command: { "_module": "...", "_op": "...", "_params": {} }
	•	array sequence of handlers

Rules:
	•	Persisted or agent-generated handlers MUST be data-only.
	•	No JS functions in persisted or agent-editable payloads.
	•	No eval.
	•	No function strings.
	•	Unknown ops must be rejected at validation boundaries.

8) XEM rules

_xem is a lightweight event bus.

Rules:
	•	Events are coordination only.
	•	Events are not state.
	•	Events are not persistence.
	•	Listener order must not be assumed.
	•	Payloads must be explicit.
	•	Use XData for state.
	•	Use _xem for signals.

9) XModule rules

XModule is the only behavior extension point.

Rules:
	•	Every module must have a unique _name.
	•	Executable ops are underscore-prefixed methods.
	•	Command "my-op" maps to method "_my_op".
	•	Modules own their objects through XObjectManager.
	•	Cross-module behavior must go through:
	•	_x.execute(...)
	•	_xem
	•	documented XData keys
	•	Modules must not mutate other modules directly.

10) XObject rules

XObject is the base runtime node.

Rules:
	•	XObject is UI-agnostic.
	•	Do not add DOM, CSS, visibility, or layout behavior to XObject.
	•	UI behavior belongs in @xpell/ui.
	•	Server behavior belongs in @xpell/node.
	•	3D behavior belongs in @xpell/3d.
	•	_data_source binding uses _xd.on(...).
	•	Data delivery is subscription-based, not frame polling.
	•	dispose() must unbind data listeners and event listeners.

11) Hard forbiddens
	•	Do not add UI behavior to @xpell/core.
	•	Do not use XData as an event bus.
	•	Do not use events as state.
	•	Do not use XData as persistence.
	•	Do not write new code through _xd._o[...].
	•	Do not rely on listener ordering.
	•	Do not use eval or executable strings in persisted payloads.
	•	Do not import _x / Xpell directly inside XObject.
	•	Do not create hidden cross-module mutation paths.
	•	Do not couple core to Node FS or browser DOM APIs.

12) Related files

Use these files for details:
	•	SKILL_API_MAP.md — public API, exports, command shapes, examples
	•	SKILL_CHECKLIST.md — review checklist before merge

