# Changelog

## [2.0.8] — 2026-11-13 (unreleased candidate)

- Compared with public 2.0.7 declarations: add structured AI messages/tools, _continuation_ref, optional generation recovery and document extraction contracts.
- Compared with public 2.0.7 declarations: add SQLite local-unit/historical backup contracts, OAuth/MCP auth types and application-package transfer declarations.
- Coordinate the current XNode, XDB, ServerXVM, Wormholes and XAI contracts with 2.0.8.
- Carry the existing SQLite local-unit accounting, durability diagnostics and signed tool-continuation contracts used by the isolated Router candidate.
- Correct qualification source paths for File Service and XNet; this does not select SQLite for application startup.

Compatibility: internal workspace specifications are retained. No public API redesign, PostgreSQL backend, persistence migration or automatic SQLite activation is introduced by this preparation.

Validation: package builds and available tests are recorded in the coordinated Gate 2 report. Gate 3 must verify the exact packed artifacts and clean-consumer compatibility before publication. These entries describe verified checked-out capabilities and release-preparation deltas; they do not claim that every capability is new relative to the last npm artifact.

