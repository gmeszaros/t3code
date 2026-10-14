# Local desktop builds on GitHub

The `Local desktop build` workflow builds a self-contained macOS arm64 app on
the standard `macos-15` runner. It runs only through `workflow_dispatch` and
uploads a ZIP and build manifest for one day. It does not publish a release,
install an app, or configure automatic updates.

Add the workflow to your own GitHub repository's default branch, then select
**Actions > Local desktop build > Run workflow** and choose the branch to build.
When importing a fork, review its inherited workflows before enabling Actions;
upstream release workflows are not configured for this personal build.

Enable only `Local desktop build` and `Mirror upstream` in the personal
repository. The snapshot job checks upstream main every Monday at 07:17 UTC
and can also run manually. It copies upstream source without the entire
`.github` directory into a separate `upstream-snapshot` branch, recording the
original SHA in each commit's `Upstream-Commit` trailer. Snapshot commits have
new identities and their own linear history; they are not upstream commits.
Use the recorded revisions to compare and integrate upstream changes into the
custom branch, then test before manually building it. Do not merge snapshot
history as if it were the original upstream history.

Unchanged upstream revisions create no commit. Divergent or backwards upstream
history stops without changing the snapshot. The job does not force-push,
change custom `main`, start a macOS build, or publish a release. It uses the
built-in `GITHUB_TOKEN` with Contents write access; no separate token or secret
is needed because no upstream workflow files are copied. Keep all inherited
upstream workflows disabled. The Linux job needs no dependencies, caches or
artifacts; the macOS job runs only on demand. GitHub schedules may be delayed,
and public scheduled workflows are disabled after 60 days without repository
activity and may need re-enabling.

The downloaded Actions artifact contains an app ZIP. Extract that ZIP, keep
the previous app for rollback, and install `T3 Code (Local).app`. The manifest
records the source revision, the common ancestor with upstream main, and the
ZIP's SHA-256. A newer upstream revision is not merged automatically.

Local builds use the same next-release base version as upstream nightly builds. Before compiling, the workflow aligns the server, desktop, web, and contracts package versions to one `-local` version. Artifact verification runs the packaged server's `--version` command and requires it to match the desktop version. This keeps provider compatibility checks aligned with the code shipped in the app.

The packaged app uses `com.t3tools.t3code.local` and `t3code-local`. Its default
T3 home is `~/.t3-zcode-test`, matching the existing Local test build, and its
Chromium storage lives below that home in `electron/t3code-local`. Explicit
`T3CODE_HOME` and `T3CODE_PORT` overrides remain supported. Existing Local
provider settings are reused; no account credentials or user databases enter
the artifact. Close the existing Local app before replacing it. Installed
production or Nightly apps keep their separate app identity and profile.

The credential-free workflow uses ad-hoc signing with hardened runtime and
Apple Events/Electron entitlements, verified against the extracted artifact.
It is not Developer ID signed or notarized, so macOS may require manual launch
approval and renewed privacy consent. CI verifies the shipped bootstrap,
identity, entitlements and signature; actual GUI automation/CUA must be tested
on the destination Mac. Entitlement-gated browser passkeys are not supplied by
ad-hoc signing. Developer ID, notarization and provisioning are a separate
setup requiring credentials and a profile authorized for the Local app ID.

Standard GitHub-hosted runner use is free for public repositories. Private
repositories consume the owner's included allowance, with charges beyond it;
artifact storage also has an allowance. See [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
Short retention and manual runs limit usage but do not enforce a spending cap.
For a private repository, configure the owner's Actions budget before running.
