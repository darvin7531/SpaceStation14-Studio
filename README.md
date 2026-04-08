# SS14 Studio

Electron + React desktop editor for SS14 prototypes, RSI sprites and project resources.

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

## License

This repository is licensed under `GNU Affero General Public License v3.0 or later`.

The full license text is in [LICENSE](./LICENSE).

Important: AGPL is a strong copyleft license, but it does not require redistribution to be free of charge. If later you want an additional no-sale restriction for bundled assets/resources, that would need a separate custom asset license and would no longer be plain AGPL.

## Current Features

- Scans YAML prototypes under `Resources/Prototypes`.
- Scans RSI sprites under `Resources/Textures`.
- Scans C# `[Prototype]`, `[RegisterComponent]`, `[DataField]` metadata for hints.
- Opens prototypes in Monaco raw YAML editor.
- Saves the selected YAML prototype block back to disk through Electron IPC.
- Creates a new basic prototype block under `Resources/Prototypes/_PrototypeStudio`.
- Shows basic validation for missing parents and missing Sprite RSI paths.
