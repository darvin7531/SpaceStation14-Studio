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

The manifest's package URLs point to the versioned prerelease. A draft's assets
are not publicly downloadable. After reviewing and publishing that prerelease,
verify its packages and signatures using the embedded public key, then copy its
`tauri-latest.json` to the published GitHub release tagged `beta-updates` in
`darvin7531/SpaceStation14-Studio`. Create that dedicated channel release as a
prerelease if it does not exist; never use a version tag or the stable/Electron
release for it. Replace that asset only after each versioned release is public
and verified. The updater accesses the fixed tag directly, not `releases/latest`;
the channel release need not be GitHub's latest release. Replacing the asset may
briefly make update checks fail. This promotion is manual and is not performed
by the draft workflow.

The manifest is not itself authenticated: Tauri verifies downloaded bundles
against their signatures and the embedded public key before installation, but
an attacker controlling the manifest can block updates or replay signed releases.
Protect GitHub release access and the signing key. Builds without the public key
remain disabled and cannot bootstrap themselves through this updater; distribute
an updater-enabled build separately. Until the channel asset exists, checks fail.
Updater-enabled releases also remain blocked by the unsaved-edit protection
prerequisite in docs/release-0.1.5-beta.md. Windows packages are updater-signed,
not Authenticode-signed; Linux packages are not distribution-signed.
