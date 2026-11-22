# Signed Tauri updater release setup (Electron parity)

The existing Electron stable assets (latest.yml and SS14-Studio-Setup exe) are incompatible with the Rust rework.
The updater cannot operate without an independently signed Tauri artifact.

1. Generate a Tauri updater signing key using the official CLI:
   npm run tauri signer generate -- -w ~/.tauri/ss14studio.key
   Keep the private key secure; never commit or share it.
2. During release compilation, set SS14_STUDIO_UPDATER_PUBKEY to the corresponding public key.
   The Rust updater plugin is registered only when that build variable exists.
   Default CI builds without the key return disabled and make no update requests.
3. Store the private key in protected CI secrets TAURI_SIGNING_PRIVATE_KEY
   (and TAURI_SIGNING_PRIVATE_KEY_PASSWORD if applicable).
   Enable release bundles with bundle.createUpdaterArtifacts=true only for signed releases.
4. Publish the signed Tauri update bundles and their .sig files with a separate
   tauri-latest.json static manifest on the GitHub latest stable release.
   Each platform entry needs a download URL and the actual signature contents.
5. Manual smoke-test Windows, Linux and macOS install, signatures, GUI and restart.
   The normal repository CI builds only unsigned test executables.

Official docs: https://v2.tauri.app/plugin/updater/
Current branch does not contain a signing key and existing releases have no Tauri manifest.
Therefore this is a prepared disabled workflow, not a deployed auto-updater.