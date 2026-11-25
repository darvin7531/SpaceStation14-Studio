# 0.1.5 beta release prerequisites

- Run Rust Rework CI and the existing manually dispatched Rust Rework Installer Packages workflow on the release commit; inspect Linux and Windows artifacts and smoke results. The packaging workflow only uploads unsigned CI artifacts; it does not publish a release.
- Block updater-enabled releases until installation is protected throughout download and restart against edits made after installation starts, including non-document editor drafts.
- Provision a Tauri updater signing key outside the repository; keep its private key and password in GitHub Actions secrets, and embed its matching public key as SS14_STUDIO_UPDATER_PUBKEY at compile time. Never commit private material.
- Configure signed updater bundles and a draft-release publishing workflow with contents: write, then verify both platform signatures and the complete tauri-latest.json before publishing. Native Windows code signing is separate from updater signing.
- The current updater URL uses releases/latest, which excludes GitHub prereleases. Choose a beta-channel manifest endpoint before enabling beta updates; do not overwrite the stable/Electron feed.
- Windows packaging overrides the application version to 0.1.5-1; verify installer and updater version comparison on Windows before release.
