# Local desktop builds on GitHub

## Repository decision (2026-10-14)

Use `gmeszaros/t3code`, a GitHub fork of `pingdotgg/t3code`. Keep `main` identical to upstream. The `local` branch contains the linear Local patch series above `main`. Create feature PRs against `local`, so their diffs contain only the feature changes.

The previous `gmeszaros/t3code-local` repository was deleted. The installed app and its profile remain unchanged. Both release checks and download links use this fork.

## Build, release and synchronization workflow

Local packaging and CI use the same command: `node scripts/build-local-desktop.mjs`.
It assigns one UTC date-and-time version, aligns package versions, builds the ZIP,
verifies the signature and shipped backend, and writes the checksum manifest.
Package versions and a temporary public `.env` are restored on success or failure.
Use `--output-dir <directory>` to keep artifacts outside the checkout.

### Local changes and upstream updates

Create feature worktrees from the latest hosted `local` and open feature PRs against `local`. Use squash or rebase merge to keep the Local patch series linear.

Update the fork's clean `main` with GitHub **Sync fork** or `gh repo sync gmeszaros/t3code --branch main`. This does not require a separate sync token. Keep Local changes off `main`.

For a Local update, use a clean worktree and the existing authenticated GitHub CLI. Fetch the fork, record the old `local` tip, and rebase only its Local commits onto the tracked `main`:

```bash
git fetch fork main local
git switch -c update/local fork/local
git rebase fork/main
```

Resolve conflicts and run scoped checks before publication. Preserve the old Local tip in a backup tag and push `HEAD:refs/heads/local` with an explicit `--force-with-lease=refs/heads/local:<old-local-sha>` after approval for that history rewrite. Verify that hosted `main` is an ancestor of hosted `local` and that `main..local` contains no merge commits. No upstream integration PR is needed.

Feature branches based on an older Local tip may need `git rebase --onto fork/local <previous-local-tip> <feature-branch>` after the update. The former scheduled mirror workflow is not used in this fork. Upstream sync and Local rebase remain explicit operations through the existing GitHub authentication.

The build fetches upstream main and records its real merge base with the source revision. An explicit `--upstream-sha <sha>` must also be an ancestor of that source. Keep build, publication and installation in one update round. One final publication approval covers the reviewed feature branch, PR merge and release. Install only after active runs finish.

The `Local desktop build` workflow builds and verifies a self-contained macOS arm64 app on the standard `macos-15` runner. Push a `v<base>-local.<UTC-date>.<UTC-time>` tag pointing to a merged commit on `local` to build that exact version. The workflow uploads the ZIP and manifest to a draft release, then publishes it as latest. No local packaging or manual asset upload is required. Existing releases are never overwritten.

The tag trigger uses the workflow from the tagged commit, so `main` stays identical to upstream. The optional `workflow_dispatch` entry remains for a future default-branch setup; GitHub cannot dispatch it manually while the file only exists on `local`. The inherited upstream release workflow excludes Local tags.

The app checks the latest published Local release and opens its download page from the sidebar update icon or Settings. It never replaces the app automatically. Release assets remain available after Actions artifacts expire; the workflow's intermediate artifact is retained for one day.

### Preparing an upstream integration in Actions

`Local upstream update` is the first stage of the upstream update pipeline. Run it
against `local`, select an upstream release tag (or leave it empty for the latest
published nightly), and leave `publish_release` off for an artifact-only trial.
The workflow rejects older or unchanged upstream bases, non-linear Local history,
and rebase conflicts. Stable and preview releases are excluded from automatic selection. An explicit
release tag remains available for controlled trials; downgrade checks still apply.

The candidate replays the Local patch series in a disposable checkout, runs scoped
integration tests and typechecks, then builds and verifies the macOS arm64 app.
The artifact includes the ZIP, checksum manifest and a Git bundle of the exact
candidate source. Build steps have read-only repository permissions.

With `publish_release` enabled, a separate job verifies the candidate and checksum,
checks that `local` has not moved, and publishes an immutable `updates/local-*`
branch and a latest Local release. It never force-pushes or updates `main` or
`local`. A failed build publishes nothing. Publication failures can leave an
immutable candidate branch, tag or draft release for inspection; inspect those
before retrying. Existing releases are never overwritten.

Before continuing development from a published candidate, reconcile it with the
maintained Local branch under a separate history-update approval. Until then,
subsequent runs still replay the current `local` patch series. Download and install
remain manual; the app does not dispatch this workflow yet.

GitHub requires a dispatchable workflow to exist on the default branch. Keeping
`main` identical to upstream therefore requires setting the fork's default branch
to `local` after merging this workflow. That repository setting is a separate
approved activation step. No PAT, signing secret, schedule or self-hosted runner
is required.

### Publishing a verified Local release

Merge the reviewed feature PR into `local` and choose a new Local version. After approving publication, tag the exact merged source and push only that tag:

```bash
git fetch fork local
git tag "v<version>" fork/local
git push fork "refs/tags/v<version>"
```

Follow **Actions > Local desktop build**. Download the app ZIP from the resulting GitHub release. Both the tag and the source revision must pass the workflow's checks before publication. The manifest records the source revision and ZIP checksum. The workflow uses GitHub's short-lived token; no personal API key, signing credential or workstation profile is needed.

Local packaging remains available as a fallback with `node scripts/build-local-desktop.mjs --output-dir release-local`. If publishing that output manually, upload both the versioned ZIP and its `.build.json` to a draft release targeting the manifest's `sourceSha`, then publish it as latest.

Publish it as a normal release, not a prerelease. The Local updater requires the exact versioned ZIP and manifest names, and only checks the latest published release. Verify the tag targets `sourceSha` and the uploaded ZIP digest matches the manifest. Check for updates from an older Local build, then verify the release page opens in this repository. Download and installation remain manual.

Keep unrelated inherited upstream workflows disabled. Enable the reviewed Local workflow when publishing its setup; leave `main` unchanged. The Local workflow does not use the upstream Blacksmith runner labels.

No scheduled credential or `UPSTREAM_SYNC_TOKEN` is configured for this fork. Native fork synchronization and locally authenticated rebasing replace the former standalone mirror updater.

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
