# Writing Xpell-Node Modules

## Module Rules
- Extend `XModule`
- Stateless by default
- Explicit inputs / outputs
- No transport awareness

## Command Shape
```ts
{
  _module: "users",
  _op: "create",
  _params: { name: "Alice" }
}
```

## Execution
All commands flow through:
```ts
_x.execute(xcmd)
```

## Forbidden
- Accessing request/socket directly
- Reading HTTP headers
- Mutating global state
