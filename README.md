# @xpell/node

Xpell 2 Alpha --- Server Runtime (xnode)

`@xpell/node` is the server-side execution layer of the Xpell 2
platform.

It provides the Node.js runtime environment for structured command
execution, real-time synchronization, and semantic data coordination
across Xpell applications.

This package replaces the legacy XNode interpreter with a modular,
AI-native server runtime designed to work with:

-   `@xpell/core` --- runtime contracts
-   `@xpell/ui` --- client UI runtime
-   `@xpell/3d` --- spatial runtime layer

> This package is part of the Xpell 2 Alpha platform.\
> Learn more at https://xpell.ai

------------------------------------------------------------------------

## What @xpell/node Provides

### Xpell Server (xnode)

A structured server execution layer built on top of Node.js.

### XCommand Execution Model

The server processes structured commands that describe:

-   `module` --- target runtime module
-   `object` --- optional runtime object
-   `op` --- operation to execute
-   `params` --- structured parameters
-   `created` --- command timestamp

This enables deterministic, modular command routing without hidden state
coupling.

### Wormholes 2

Real-time client/server bridge for:

-   Live state synchronization
-   Distributed runtime mutation
-   Multi-user systems

### XDB Integration

Server-side data layer supporting structured objects and semantic-ready
storage.

------------------------------------------------------------------------

## Design Principles

-   Explicit command routing
-   Modular runtime behavior via XModule
-   No implicit cross-module mutation
-   Real-time execution compatibility
-   AI-collaborative architecture
-   TypeScript-based

------------------------------------------------------------------------

## Installation (Alpha)

npm install @xpell/node@alpha

Typically used together with:

npm install @xpell/core@alpha\
npm install @xpell/ui@alpha

Alpha builds are intentionally not published under the `latest` tag.

------------------------------------------------------------------------

## When to Use @xpell/node

Use this package when you need:

-   Server-side execution of Xpell modules
-   Real-time synchronization between clients
-   Structured command processing
-   Multi-user systems
-   Semantic data coordination (via XDB)
-   Foundation for SSR and distributed runtime systems

------------------------------------------------------------------------

## Architecture Role in Xpell 2

Xpell 2 is modular:

-   `@xpell/core` → Runtime contracts + execution engine\
-   `@xpell/ui` → Real-time UI framework\
-   `@xpell/3d` → Three.js-based spatial runtime\
-   `@xpell/node` → Server runtime (xnode, Wormholes, XDB)

`@xpell/node` executes and coordinates runtime logic on the server side.

------------------------------------------------------------------------

## Alpha Status

This package is currently in Alpha.

-   APIs may evolve
-   Runtime contracts may be refined
-   Server-side performance tuning is ongoing

Intended for early adopters and architectural experimentation.

------------------------------------------------------------------------

## Documentation & Links

Website: https://xpell.ai\
GitHub: https://github.com/xpell-ai/xpell-node

------------------------------------------------------------------------

## Versioning

Follows semantic versioning under the Xpell 2 release stream.

------------------------------------------------------------------------

## License

MIT License --- © Aime Technologies
