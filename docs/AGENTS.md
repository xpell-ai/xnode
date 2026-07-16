## `packages/xpell-node/AGENTS.md`

# AGENTS.md — @xpell/node

Before making changes, apply Codex skills:

- xpell-contract
- xpell-core
- xpell-node
- xpell-xdb
- xpell-xvm
- xflow-manager
- xpell-xvibe

Rules:
- Server only.
- No DOM/browser/UI code.
- Use XModule and `_x.execute`.
- Wormholes is the only client/server transport boundary.
- FlowManager executes behavior; it does not know UI structure.
- Server XVM persists apps/views/flows/entities as validated JSON.
- Do not infer missing state.