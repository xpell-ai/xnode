---
name: xpell-contract
description: Canonical foundation contract for all Xpell work across core, ui, node, 3d, apps, VIBE, and AIME. Use for any Xpell-related coding, architecture, Codex prompt, skill, or repo review to enforce no-inference, deterministic runtime, layer boundaries, _snake_case runtime fields, XModule behavior, _x.execute command flow, XData discipline, XEM event rules, data-only nano commands, and reuse-before-generation.
---

# Xpell Contract

Apply this as the strict base contract for all Xpell work.

## Prime Directive

Do not infer missing state.

If required information is missing, inspect the relevant repo/file/tree or ask for it. Do not guess APIs, paths, state ownership, persistence, module behavior, or runtime flow.

## Scope

This contract applies to all Xpell layers and products:

- `@xpell/core`
- `@xpell/ui`
- `@xpell/node`
- `@xpell/3d`
- Xpell apps
- VIBE / AIME repos
- Codex-generated work
- AI-generated plans, views, flows, entities, modules, and skills

Layer/product skills may add stricter rules, but must not violate this contract.

## Layer Direction

```text
xpell-contract
  ↓
xpell-core
  ↓
xpell-ui / xpell-node / xpell-3d
  ↓
apps / products / VIBE / AIME
```
Rules:
	•	xpell-contract defines global invariants only.
	•	It must not depend on higher layers.
	•	UI, node, 3D, XVM, Flow, VIBE, and AIME details belong in their own skills.
	•	Higher layers implement this contract; the contract does not implement them.

# Deterministic Runtime

Xpell is a deterministic real-time interpreter.

Rules:
	•	State must be explicit and inspectable.
	•	No hidden auto-magic.
	•	No hidden auto-repair.
	•	No silent background mutation.
	•	No implicit persistence.
	•	No inferred architecture.
	•	Runtime behavior must happen through modules, commands, events, or documented XData keys.

# Naming

Runtime-managed fields must use:

_snake_case

Rules:
	•	Runtime/system fields start with _.
	•	Command params use snake_case.
	•	CLI params use snake_case.
	•	Method names may use camelCase.
	•	Module operations are exposed as underscore methods.

Examples:

_x.execute({
  _module: "users",
  _op: "create",
  _params: {
    display_name: "Tamir"
  }
});

{
  "_module": "users",
  "_op": "create",
  "_params": {
    "display_name": "Tamir"
  }
}


# Command Execution

_x.execute(...) is the canonical execution path.

Rules:
	•	External actions must route through _x.execute.
	•	Transport layers must not call module internals directly.
	•	Flow steps must execute commands, not arbitrary functions.
	•	Remote commands must be validated before execution.
	•	Commands must be explicit JSON-compatible data.

Canonical command:

{
  "_module": "module_name",
  "_op": "operation_name",
  "_params": {}
}

# XData

XData is shared runtime memory, not persistence.
Rules:
	•	Every mutation must include a stable source.
	•	Keys must be stable and namespaced.
	•	Do not use XData as a database.
	•	Do not use XData as an event bus.
	•	Do not mirror XData into hidden shadow state.

# Events

Events coordinate behavior. Events are not state.

Rules:
	•	_xem is a lightweight event bus.
	•	Listener order must not be assumed.
	•	Payloads must be explicit.
	•	No hidden control flow through events.
	•	Core event systems must stay platform-neutral.
	•	DOM/browser event adaptation belongs in UI-layer skills.

Example:

_xem.fire("vibe:prompt:send", {
  source: "vibe-editor"
});

# Persistence

Persistence must be explicit.

Rules:
	•	XData is not persistence.
	•	Persistence must go through explicit stores, adapters, repositories, or module ops.
	•	Do not write authoritative files directly when a module owns them.
	•	Persisted app/view/flow/entity/plan data must be JSON/data-only.
	•	Do not persist functions or executable JavaScript.

Correct:

module op → validation → persistence adapter

# Nano-Commands v2

Persisted handlers must be data-only.

Allowed forms:

String nano-command:

"toggle target:'menu'"

Object command:

{
  "_op": "toggle",
  "_params": {
    "target": "menu"
  }
}

Module command:

{
  "_module": "xem",
  "_op": "fire",
  "_params": {
    "event": "vibe:prompt:send"
  }
}

Sequence:

[
  {
    "_module": "xd",
    "_op": "set",
    "_params": {
      "key": "ui:status",
      "value": "saving",
      "source": "save-flow"
    }
  },
  {
    "_module": "users",
    "_op": "create",
    "_params": {
      "display_name": "Tamir"
    }
  }
]

Rules:
	•	No persisted JS functions.
	•	No eval.
	•	No function strings.
	•	No inline scripts.
	•	Unknown ops must be rejected at validation boundaries.
	•	Nano commands without _module are local/object-scoped.
	•	Commands with _module route through _x.execute.

# Transport Boundary

External input is untrusted.

Rules:
	•	Validate envelopes before execution.
	•	Validate command shape before execution.
	•	Inject server-owned metadata only at trusted gateways.
	•	Never trust client-authored auth/session/connection params.
	•	External requests must route through _x.execute.
	•	Do not expose raw transport objects to modules.

# AI Boundaries

AI may reason, plan, and generate data.

Rules:
	•	AI must not directly mutate runtime state.
	•	AI output must be validated before apply.
	•	AI output must become plans, commands, views, flows, entities, or patches.
	•	AI must not bypass module boundaries.
	•	AI must not generate persisted functions.
	•	AI must not invent APIs when repo/source truth is available.

Correct:

prompt → plan → validate → apply through module ops

# Reuse Before Generation

Do not recreate known capabilities.

Rules:
	•	Search existing utilities, modules, packs, commands, and contracts first.
	•	Prefer existing helpers over new boilerplate.
	•	Prefer feature packs over generating large systems from scratch.
	•	Generate only the missing delta.
	•	If unsure whether a capability exists, inspect the API map/checklist or ask.

Principle:

compose existing capabilities first
generate only what is missing

# Timers and Background Work

No hidden loops.

Forbidden by default:

setInterval
polling loops
busy loops
unbounded retries
hidden background schedulers

Allowed only when a layer skill explicitly permits it:

bounded timeout
debounce
request deadline
reconnect backoff
post-mount microtask
animation/frame hook

# Output Discipline for Codex / AI

When generating or modifying code:
	•	Do not invent file paths.
	•	Inspect repo tree when paths are unknown.
	•	Prefer small auditable changes.
	•	Keep behavior deterministic.
	•	Add logging only where useful.
	•	Do not introduce hidden state.
	•	Do not introduce new architecture unless requested.
	•	Update related docs, API maps, and checklists when public behavior changes.
	•	Respect layer skills and repo-local codex.md / AGENTS.md.

Precedence

1. xpell-contract
2. layer skill
3. product skill
4. repo-local codex.md / AGENTS.md

Repo-local rules may be stricter, but must not contradict this contract.