# SS14 Studio — Rust Rework

**Branch:** rework/rust-tauri  
**Current preview:** 0.1.5-alpha.1 (pre-1.0, not v2).

SS14 Studio is being rewritten on **Rust + Tauri 2**. The desktop application in this branch has no Electron and no Node.js desktop runtime. Node.js is used only during frontend development/build through React, TypeScript and Vite. The old Electron implementation remains on the main branch for reference during feature migration.

## What is working now

- A native Tauri window with a lightweight React interface and an OS-native folder picker (only `dialog:allow-open` permission). The last successful project path is remembered locally.
- Open and verify the root directory of a Space Station 14 source checkout.
- Read-only inventory of YAML prototype files, RSI folders and Fluent files.
- **Lazy Rust YAML declaration catalog:** enumerate real prototype `type` + `id` entries, parents, abstract flag, source line and multi-document origin. Search uses a prebuilt in-memory index; parse happens once when the Prototypes pane is opened.
- Partial declarations are kept separate: configured partial directories from `Resources/PartialPrototypes/partialPrototypes.yml`, `!PartialOnly`, `!Partial:0`. Unsupported dynamic IDs are reported, not silently treated as ordinary prototypes.
- Source-level prototype graph: direct parent links, reverse child references, definition provenance, conservative missing-reference and static cycle diagnostics. Links from partials stay tagged by provenance; dynamic references are never assumed to be a confirmed engine inheritance path.
- Parsed YAML diagnostics are exposed in a separate paginated view. A malformed source file is reported without poisoning the index of other files.
- Search by resource path and type, with pagination; queries use precomputed case-insensitive keys and resource reads use a direct lookup map, with no filesystem walk per search.
- Display YAML/FTL contents and RSI meta.json in a Monaco-based syntax-highlighted viewer. Monaco and its worker are bundled locally (offline); JSON metadata uses lightweight syntax colouring without the heavy JSON language service. Open tabs are bounded and support close/reload.
- Actionable Russian-language error handling with stable codes, hints and expandable technical details.
- Frontend YAML draft buffers with explicit discard confirmation on tab close, reload and project switch; Ctrl+S saves the active YAML file. Per-project recovery snapshots are now written to the Tauri app-data directory (not the SS14 checkout), using SHA-256 keys, bounded text, restricted permissions on Unix, same-directory temp file and atomic replacement. UI compares the stored text to the current disk version, and requires deliberate conflict resolution before an outdated recovered draft can overwrite external edits.
- Conflict-aware raw YAML text-saving backend (not semantic editing): SHA-256 revision checks, syntax validation, same-directory temporary file + fsync + replace, symlink refusal, cache invalidation, and no implicit overwrite. Edits are byte-preserving with respect to the user's submitted text (comments, order and SS14 tags are not reserialized). No file mutation occurs for read-only RSI/FTL.
- **Create prototype (new-file and append modes):** Rust-validated wizard for type, ID, one parent, abstract/name/description, entity Sprite/Item/Physics/Appearance stubs, destination path and authoritative YAML preview. New files use exclusive `create_new`. Appending is limited to *already indexed* conventional one-document YAML sequences, never Partial-tagged or multi-document files. Rust parses the original, constructs one new sequence item without reserializing existing source, validates the combined YAML and its list length/content, and verifies an exact SHA-256 expected revision before atomically saving. Duplicate type+ID declarations are rejected; the frontend blocks appending into an open dirty tab. After writing, the prototype catalog refreshes while unrelated drafts stay intact. Full structural/CST block editing is still future work.
- **Existing prototype field form (conservative first slice):** use the “Поля” action on an ordinary indexed declaration to edit simple `parent`, `name`, `description` and `abstract` fields. Rust verifies document/item identity and original vs resulting YAML AST, changes only specific source lines without serializing the entire document, and refuses ambiguous/complex layouts or Partial declarations. The patch changes the in-memory editor draft only; use the existing Ctrl+S with SHA-256 conflict handling to persist it. List-valued parents, tagged fields and block scalar descriptions remain text-editor-only.
- **Component scalar field editing:** the components panel now lists direct field names, inferred YAML scalar kinds (`string`, `bool`, `int`, `float`) and nested/complex fields as read-only. A typed field edit rewrites only its direct source line, preserves inline comments and line endings, and validates that the YAML tree changed only at that exact field of the exact component; stale component identity, duplicate or unusual source fields, tags, multi-line strings, and invalid numbers are rejected. The result remains a draft until Ctrl+S, with no automatic disk writes. Fields are not yet validated against C# `DataField` metadata.
- **Prototype components (conservative first slice):** for ordinary `entity` declarations, the “Компоненты” action shows explicitly declared components and their field counts; you can add a minimal `type` component block or remove a selected block after confirmation. Rust checks the exact source item identity, validates the resulting YAML tree, and rejects cases where other declarations/fields change. Existing source text is not globally serialized; deletion refuses comment-bearing blocks. All operations apply only to a draft; Ctrl+S performs the conflict-aware disk write. This is not an inheritance-aware component inspector or a full nested-field editor. Complex/partial/tagged layouts are intentionally unsupported.
- **YAML diff review:** a locally bundled, lazy-loaded Monaco diff editor compares the current disk version with an unsaved or restored draft, highlights edits, and lets the user toggle inline / side-by-side views and whitespace comparison. The preview is read-only, with a text fallback for very large files or editor initialization errors. Conflict review must be manually accepted and rechecks disk revision and the exact reviewed draft; accepting a revision never saves source text on its own.
- Recovery is best-effort: snapshots are debounced by 750 ms, so the last keystrokes immediately before a crash might be absent. A failed journal write is surfaced as an error; no unconditional promise of backup durability is made.
- Rust/TypeScript CI checks and unit tests.

**Limitations:** Diff is a review/decision tool, not automatic three-way merging; manually reconcile conflicting YAML before saving. Current counts refer to YAML *files*, not individual prototype declarations. This is an early functional Rust preview, not a feature-complete replacement for the old editor. Existing-prototype visual/YAML-CST editing, resolved inheritance, C# symbol extraction, persistent incremental index and RSI image preview are intentionally not claimed as implemented. The prototype catalog is a read-only *declaration index*, not an engine-accurate resolved graph. External file changes currently require reopening the workspace unless the affected file is explicitly reread. File writes are protected by application-local serialization and optimistic revision checks, not by an OS-wide lock; a concurrent external writer can theoretically race between the final check and rename.

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

CI also compiles the complete Tauri application with `npm run build -- --no-bundle` (Linux). It does not launch the GUI or generate an installer. Production packaging is not enabled until editing, feature-parity and platform-smoke tests are added. The root package uses npm semver dependencies; a lockfile and pinned release build are mandatory before a binary release.

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
