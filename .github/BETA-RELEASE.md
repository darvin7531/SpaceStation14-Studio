# Beta release

Dispatch **Draft beta release** on the branch to release, with its existing
`package.json` and `src-tauri/tauri.conf.json` beta version (for example,
`0.1.5-beta.1`). The workflow builds Linux and Windows installers and creates
a **draft prerelease** tagged `v<version>`; it never publishes the release.
Review the packages and `tauri-latest.json` before publishing manually.

Configure the repository secret `TAURI_SIGNING_PRIVATE_KEY`, and, if the key is
password-protected, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Set the repository
variable `SS14_STUDIO_UPDATER_PUBKEY` to the matching Tauri public key. Provision
these separately; do not commit signing keys. CI checks that a key and public
key exist, but does not establish that they match. Verify the signed update with
the actual public key before publication.

The manifest and the URLs inside it are version-specific GitHub release assets.
A draft's assets are not publicly downloadable. GitHub's `releases/latest`
endpoint excludes prereleases, so it does **not** serve this beta manifest.
The app's current updater endpoint uses `releases/latest`; beta discovery
requires a separately hosted stable beta manifest endpoint and an app change
before beta automatic updates can work. Windows packages are updater-signed,
not Authenticode-signed; Linux packages are not distribution-signed.
