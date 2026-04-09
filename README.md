# SS14 Studio

SS14 Studio is a desktop tool for working with content in any SS14 source build.

Its goal is to make creating prototypes, RSI sprites, and other project resources faster, clearer, and less error-prone, so content creators can turn ideas into working content with less manual overhead.

The editor is designed as a unified workspace for scanning an SS14 project, understanding its available components and resources, and helping with common content tasks through validation, previews, and guided editing workflows.

## Run

```powershell
npm install
npm run dev
```

Then click `Open Project` and select the SS14 source root that contains `Resources/Prototypes`.

## Build Installer

Windows installer:

```powershell
npm install
npm run dist:win
```

Portable Windows build:

```powershell
npm install
npm run dist:portable
```

Artifacts are written to `release/`.

## Manual Stable Release In GitHub

There is a manual GitHub Actions workflow for stable releases:

1. Bump `version` in [package.json](./package.json) and push it to `main`.
2. Open `Actions` -> `Release Stable`.
3. Click `Run workflow`.
4. The workflow builds:
   - NSIS installer
   - portable `.exe`
   - updater metadata (`latest.yml`, blockmaps)
5. It then publishes a GitHub Release with the current package version.

The updater expects the version in `package.json` to already be correct before you run the workflow.

## License

This repository is licensed under `GNU Affero General Public License v3.0 or later`.

The full license text is in [LICENSE](./LICENSE).

Important: AGPL is a strong copyleft license. It requires modified networked/distributed versions of the software to remain available under the same license terms, but it does not by itself prohibit commercial distribution.

## Current Features

- Scans YAML prototypes under `Resources/Prototypes`.
- Scans RSI sprites under `Resources/Textures`.
- Scans C# `[Prototype]`, `[RegisterComponent]`, `[DataField]` metadata for hints.
- Opens prototypes in Monaco raw YAML editor.
- Saves the selected YAML prototype block back to disk through Electron IPC.
- Creates a new basic prototype block under `Resources/Prototypes/_PrototypeStudio`.
- Shows basic validation for missing parents and missing Sprite RSI paths.
