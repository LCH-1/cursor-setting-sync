# Change Log

All notable changes to Cursor Setting Sync will be documented in this file.

## [0.0.2] - 2026-07-25

### Fixed

- Chat synchronization crashed every cycle ("Adapter state-vscdb-chat scan failed... Received null") whenever a Cursor database row held a SQL NULL. NULL values are now carried with their SQLite storage class across every capture and apply path and round-trip as SQL NULL, and one unusable row is skipped with a warning instead of taking down the whole adapter scan.

## [0.0.1] - 2026-07-20

### Added

- Initial public release
- Encrypted multi-device synchronization for Cursor settings, profiles, extensions, user files, and supported chat data
- Encrypted offline synchronization for allowlisted Cursor `workspaceStorage`: portable typed `state.vscdb` rows merged with SQL, plus notepads and images; `workspace.json` is identity metadata only and deletions remain device-local
- Forward-compatible database synchronization policy that defers newer-version data on older clients
- Conflict preservation, offline database application, backups, diagnostics, repository maintenance, and recovery commands
- Query-only live database mutation: no SQLite file replacement, per-key workspace/store merges, pre-commit integrity checks, and bounded local backup retention
