# Prototype Studio

Electron + React editor for SS14 prototype content.

## Run

```powershell
npm install
npm run dev
```

Then click `Open Project` and select the SS14 source root that contains `Resources/Prototypes`.

## Current Features

- Scans YAML prototypes under `Resources/Prototypes`.
- Scans RSI sprites under `Resources/Textures`.
- Scans C# `[Prototype]`, `[RegisterComponent]`, `[DataField]` metadata for hints.
- Opens prototypes in Monaco raw YAML editor.
- Saves the selected YAML prototype block back to disk through Electron IPC.
- Creates a new basic prototype block under `Resources/Prototypes/_PrototypeStudio`.
- Shows basic validation for missing parents and missing Sprite RSI paths.
