# Xpell-Node — Security Model

## Trust Boundaries
- Transport is untrusted
- Gateway validates everything
- Modules assume validated input

## Authentication
- Token-based AUTH
- Server returns `_sid`
- `_sid` required for REQ / EVT

## Authorization
- Optional clearance levels
- Enforced in gateway or module

## Logging
- Never log secrets
- Use `_trace` for correlation

## Non-Goals
- OAuth provider
- Session cookies
- Browser auth helpers
