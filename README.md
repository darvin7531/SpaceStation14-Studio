# SS14 Studio — Rust Rework

**Branch:** rework/rust-tauri  
**Current preview:** 0.1.5-alpha.1 (pre-1.0, not v2).

SS14 Studio is being rewritten on **Rust + Tauri 2**. The desktop application in this branch has no Electron and no Node.js desktop runtime. Node.js is used only during frontend development/build through React, TypeScript and Vite. The old Electron implementation remains on the main branch for reference during feature migration.

## What is working now

- A native Tauri window with a lightweight React interface.
- Open and verify the root directory of a Space Station 14 source checkout.
- Read-only inventory of YAML prototype files, RSI folders and Fluent files.
- Search by resource path and type, with pagination; queries use precomputed case-insensitive keys and resource reads use a direct lookup map, with no filesystem walk per search.
- Display YAML/FTL contents and RSI meta.json in a Monaco-based syntax-highlighted, read-only viewer. Monaco and its worker are bundled locally (offline); JSON metadata uses lightweight syntax colouring without the heavy JSON language service. Open tabs are bounded and support close/reload.
- Actionable Russian-language error handling with stable codes, hints and expandable technical details.
- No source file mutations, no symlink traversal during indexing, capped initial scan, capped text-file read size.
- Rust/TypeScript CI checks and unit tests.

**Limitations:** Current counts refer to YAML *files*, not individual prototype declarations. This is the first functional Rust work slice, not a feature-complete replacement for the old editor. YAML parsing and editing, Monaco, inheritance, C# symbol extraction, persistent incremental index and RSI preview are intentionally not claimed as implemented.

## Develop

Install Node 22+, the stable Rust toolchain and Tauri 2 system prerequisites:

- https://v2.tauri.app/start/prerequisites/

Run from the repository root:

    npm install
    npm test
    npm run build:web
    cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
    cargo test --manifest-path src-tauri/Cargo.toml --all-targets
    cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
    npm run dev

Production packaging is not enabled until editing, feature-parity and platform-smoke tests are added. The root package uses npm semver dependencies; a lockfile and pinned release build are mandatory before a binary release.

## Architecture

- UI: React + TypeScript + Vite. Never touch project files directly.
- IPC boundary: src/lib/api.ts — only typed, narrow Tauri commands.
- Backend: src-tauri/src/lib.rs and src-tauri/src/project.rs.
- Errors: src-tauri/src/error.rs and src/lib/errors.ts.
- Project index: immutable snapshot loaded off the UI thread and atomically replaced; searches never traverse the filesystem.
- Source files are authoritative. Derived indexes must be rebuildable.

## Rework roadmap

1. Migrate the existing Monaco editor, tab/workspace UX and i18n with a typed Tauri API. Keep file editing disabled until safe write semantics are implemented.
2. Incremental file watcher and persistent SQLite index with rapid warm startup.
3. Correct lossless YAML/CST editing, unique declaration identity, SS14 inheritance and partial prototype semantics; verification against RobustToolbox fixtures.
4. Conflict-safe file saving with revision checks, atomic replace where supported, useful error explanations and recovery steps.
5. C# metadata analysis, Fluent parsing and diagnostics, RSI metadata/images with lazy binary previews.
6. Search/graph/UI optimization and benchmarks on several real SS14 forks.
7. Signed installers, lockfiles, cross-platform smoke tests, stable release pipeline.

Rules: prevent data loss, do not hide errors or fake success, do not silently overwrite external changes, keep CI green, and measure performance before promising speedups.

License: GNU AGPL v3.0 or later.
