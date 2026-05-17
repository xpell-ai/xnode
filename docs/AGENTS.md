## `packages/xpell-node/AGENTS.md`

# AGENTS.md — @xpell/node

Before making changes, apply:

- /docs/skills/xpell-contract
- /docs/skills/xpell-core
- /docs/skills/xpell-node
- /docs/skills/xpell-xdb
- /docs/skills/xpell-xvm

Rules:
- Server only.
- No DOM/browser/UI code.
- Use XModule and `_x.execute`.
- Wormholes is the only client/server transport boundary.
- FlowManager executes behavior; it does not know UI structure.
- Server XVM persists apps/views/flows/entities as validated JSON.
- Do not infer missing state.