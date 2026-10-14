# Local desktop builds on GitHub

## Repository decision (2026-10-14)

Use `gmeszaros/t3code`, a GitHub fork of `pingdotgg/t3code`. Keep `main` identical to upstream. The `local` branch contains the linear Local patch series above `main`. Create feature PRs against `local`, so their diffs contain only the feature changes.

The previous `gmeszaros/t3code-local` repository retains historical releases and branches. The migration leaves the installed app and its profile unchanged. Future builds check releases in this fork.

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

The `Local desktop build` workflow builds a self-contained macOS arm64 app on
the standard `macos-15` runner. It runs only through `workflow_dispatch` and
uploads a ZIP and build manifest for one day. The optional **Publish release** input publishes a verified manual-download release when building `local`. Branch builds never publish. The app checks the latest published Local release and opens its download page from the sidebar update icon or Settings. It never replaces the app automatically. Release assets remain available after Actions artifacts expire.

The workflow lives on `local` so default `main` stays identical to upstream. GitHub requires manually dispatched workflows to exist on the default branch, so this fork does not currently support dispatching the Local build through Actions. Use `node scripts/build-local-desktop.mjs` locally. Release publication is a separately approved operation. See [GitHub manual workflow requirements](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow). After packaging verification, the workflow uploads the ZIP and manifest to a draft release and publishes it as latest. An existing tag is never overwritten.
When importing a fork, review its inherited workflows before enabling Actions;
upstream release workflows are not configured for this personal build.

Keep inherited upstream workflows disabled. The Local workflow definition is retained for a future explicit CI setup. Leave `main` unchanged and use local packaging until that setup is approved.

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
