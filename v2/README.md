# SS14 Studio 2.0 — experimental Tauri foundation

This is an isolated first milestone. The Electron app in the repository root remains unchanged. This preview is **not** a replacement for the editor yet.

## What works

- A native Tauri 2 window displaying an offline, dependency-free preliminary UI.
- A Rust command that accepts a project root and checks for Resources/Prototypes.
- Recursive inventory of YAML files, RSI directories and FTL files. Counts are **files/directories**, not parsed prototypes, and no source file is modified.
- All known project-opening errors have structured codes, readable Russian descriptions, optional technical details and recovery hints.
- Filesystem work runs on Tauri's blocking task pool; symlinks are not followed.
- Rust unit tests, frontend error-serialization tests and CI.
- Does **not** yet parse YAML, start a watcher, edit files or restore Electron workspace state.

## Development

Install the stable Rust toolchain and the operating system dependencies for Tauri 2.

From the repo root:

    cargo test --manifest-path v2/src-tauri/Cargo.toml
    node --test v2/tests/*.test.mjs

For the actual desktop UI, install the Tauri CLI:

    cargo install tauri-cli --version '^2' --locked
    cd v2/src-tauri
    cargo tauri dev

The initial UI uses static HTML and native Tauri's global JS API so the first milestone requires no additional npm frontend dependencies. The existing React/Monaco frontend will be migrated behind a typed adapter in the next milestones, not embedded before it can actually work.

## Validation and reliability rules

- The original source repo is read-only to this initial prototype.
- Incomplete or absent optional resource directories produce warnings, not fatal errors.
- Invalid project roots and filesystem failures produce error code/message/hint/details fields.
- Scan limits prevent accidentally traversing unbounded directory trees.
- A project must explicitly have Resources/Prototypes.
- This inventory deliberately skips symlinks (including symlinked resource folders). Supporting external roots safely needs a project-configuration design.
- Currently no Cargo.lock is checked in. Generate and commit a lockfile before distributing binaries/release builds, once the CI-selected dependency versions are confirmed.

## Next milestones

1. Typed Tauri adapter + reuse of the existing React/Monaco UI.
2. SQLite persistent index, incremental scans and filesystem watcher.
3. Lossless YAML parsing, partial prototypes, full inheritance resolution and diagnostics.
4. Safe file editing with revision/conflict checks, RSI/Fluent tooling.
5. Benchmarks on representative SS14 forks, signed release pipelines.
