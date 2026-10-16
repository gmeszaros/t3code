# Local desktop builds on GitHub

## Repository decision (2026-10-14)

Use `gmeszaros/t3code`, a GitHub fork of `pingdotgg/t3code`. Keep `main` at the selected published upstream nightly commit. The `local` branch preserves our feature commits and merges updated `main` without rewriting history. Create feature PRs against `local`, so their diffs contain only the feature changes.

The fork is public and its default branch is `local`. Both release checks and download links use this fork. Keep the reviewed Local build and update workflows available on that default branch so GitHub can dispatch them.

## Build, release and synchronization workflow

Local packaging and CI use the same command: `node scripts/build-local-desktop.mjs`.
It assigns one UTC date-and-time version, aligns package versions, builds the ZIP,
verifies the signature and shipped backend, and writes the checksum manifest.
Package versions and a temporary public `.env` are restored on success or failure.
Use `--output-dir <directory>` to keep artifacts outside the checkout.

### Local changes and upstream updates

Create feature worktrees from the latest hosted `local` and open feature PRs against `local`. Use squash merge for feature PRs. Upstream integrations use merge commits and preserve existing Local history.

The `Local upstream update` workflow fast-forwards the fork's clean `main` to
the latest published upstream nightly, then merges that exact revision into a
disposable candidate based on `local`. This preserves the identity of every Local
commit, including earlier integration merges. No rebase or force-push is used.
GitHub's **Sync fork** follows upstream branch HEAD instead of a release tag;
use the workflow when the published nightly is the required boundary.

A sync is allowed only when the existing fork `main` is an ancestor of the selected
nightly. Diverged or newer fork history stops the workflow without rewriting it.
After synchronization, `main` remains updated even if the candidate later conflicts
or fails verification. Conflicts require a reviewed resolution; do not discard
Local changes or automatically choose one side.

Feature PRs contain only feature/workflow changes and target `local`. Upstream
integration is a merge performed by the update pipeline, not a rebased patch
series or an upstream integration PR.

The build fetches upstream main and records its real merge base with the source revision. An explicit `--upstream-sha <sha>` must also be an ancestor of that source. Keep build, publication and installation in one update round. One final publication approval covers the reviewed feature branch, PR merge and release. Install only after active runs finish.

The `Local desktop build` workflow builds and verifies a self-contained macOS arm64 app on the standard `macos-15` runner. Push a `v<base>-local.<UTC-date>.<UTC-time>` tag pointing to a merged commit on `local` to build that exact version. The workflow uploads the ZIP and manifest to a draft release, then publishes it as latest. No local packaging or manual asset upload is required. Existing releases are never overwritten.

The tag trigger uses the workflow from the tagged commit, so `main` stays identical to upstream. Manual dispatch is available because the workflows exist on the default `local` branch. The inherited upstream release workflow excludes Local tags.

The app checks the latest published Local release and opens its download page from the sidebar update icon or Settings. It never replaces the app automatically. Release assets remain available after Actions artifacts expire; the workflow's intermediate artifact is retained for one day.

### Building a feature branch without publishing

Commit and run the scoped checks for the change, then push its feature branch to `gmeszaros/t3code`. Dispatch the Local workflow against that branch with release publication disabled:

```bash
gh workflow run local-desktop.yml --repo gmeszaros/t3code --ref feature/my-change -f publish_release=false
gh run list --repo gmeszaros/t3code --workflow local-desktop.yml --branch feature/my-change --event workflow_dispatch
```

Verify that the selected run's `headSha` matches the reviewed commit and that the build finishes successfully. Download its Actions artifact, which contains the app ZIP and `.build.json` checksum manifest. The artifact expires after one day. Record the run URL, source revision and version in the task that owns the change.

This path does not merge the feature branch, change `local`, create a release or install the app. Approval to push and build alone does not authorize those later operations. A successful build verifies packaging, signature and shipped revision. Verify the changed behavior on the destination Mac separately before describing it as fixed.

### Preparing an upstream integration in Actions

`Local upstream update` is the first stage of the upstream update pipeline. Run it
against `local`, select a published upstream release tag (or leave it empty for the
latest nightly), and leave `publish_release` off for an artifact-only trial.
Stable and preview releases are excluded from automatic selection. Downgrade
and conflict checks still apply to explicitly selected tags.

The synchronization job only performs a fast-forward of `main`. The build job has
read-only repository permissions, merges synchronized `main` into a disposable
Local candidate, runs scoped integration tests and typechecks, then builds and
verifies the macOS arm64 app. The artifact includes the ZIP, checksum manifest
and a Git bundle of the exact candidate source. An artifact-only trial updates
`main` but leaves `local`, releases and the installed app unchanged.

With `publish_release` enabled, a separate job verifies the candidate and checksum,
checks that `local` has not moved, and requires both the original Local tip and
upstream nightly to remain ancestors. It atomically pushes an immutable
`updates/local-*` branch and fast-forwards `local` to the verified merge, then
publishes a latest Local release. No history is rewritten. A failed build leaves
`local` unchanged and publishes nothing. Publication failures can leave a verified
Local update, candidate branch, tag or draft release for inspection; inspect those
before retrying. Existing releases are never overwritten.

Further feature work starts from the updated `local`; its original feature commits
remain in history. Download and install remain manual; the app does not dispatch
this workflow yet.

GitHub requires a dispatchable workflow to exist on the default branch. The fork uses `local` as that default so `main` can remain identical to upstream. Preserve this setting when maintaining the workflows. No PAT, signing secret, schedule or self-hosted runner is required.

### Publishing a verified Local release

Merge the reviewed feature PR into `local` and choose a new Local version. After approving publication, tag the exact merged source and push only that tag:

```bash
git fetch fork local
git tag "v<version>" fork/local
git push fork "refs/tags/v<version>"
```

Follow **Actions > Local desktop build**. Download the app ZIP from the resulting GitHub release. Both the tag and the source revision must pass the workflow's checks before publication. The manifest records the source revision and ZIP checksum. The workflow uses GitHub's short-lived token; no personal API key, signing credential or workstation profile is needed.

Alternatively, after merging the reviewed change and approving release publication, dispatch `local-desktop.yml` against `local` with `publish_release=true`. That builds the exact selected Local revision, assigns a new version and publishes the verified ZIP and manifest. Publication from a feature branch is not supported. Inspect existing tags, releases and workflow runs before retrying a failed publication.

Local packaging remains available as a fallback with `node scripts/build-local-desktop.mjs --output-dir release-local`. If publishing that output manually, upload both the versioned ZIP and its `.build.json` to a draft release targeting the manifest's `sourceSha`, then publish it as latest.

Publish it as a normal release, not a prerelease. The Local updater requires the exact versioned ZIP and manifest names, and only checks the latest published release. Verify the tag targets `sourceSha` and the uploaded ZIP digest matches the manifest. Check for updates from an older Local build, then verify the release page opens in this repository. Download and installation remain manual.

Keep `CI`, `Mobile Fingerprint Check`, `Local desktop build` and
`Local upstream update` enabled as this fork's repository-owned workflows.
GitHub's managed `Dependency Graph` workflow may also appear when dependency
alerts are enabled. Keep unrelated inherited upstream
workflows disabled, including scheduled Android builds and workflows requiring
upstream credentials or Blacksmith runners. Review this allowlist after upstream
synchronization; leave `main` unchanged. The Local workflows use standard GitHub
runner labels.

No scheduled credential or `UPSTREAM_SYNC_TOKEN` is required for this fork. The update workflow uses GitHub's short-lived token to synchronize `main` and preserve Local history through a verified merge.

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

For native ZCode runtime updates, complete the separate [compatibility review](zcode-runtime-compatibility.md) before recommending adoption.

### Public source and artifacts

Before pushing new source, inspect tracked files and scan the proposed revision and Local-specific history for credentials. Include retained tags when they expose older Local commits. Review scanner findings individually because vendored test fixtures and public client identifiers can resemble secrets. `.gitignore` prevents accidental additions but does not remove files or credentials already committed. Keep reusable dev credentials and pairing URLs out of source, logs and release notes. See [Reusable dev credential](development.md#reusable-dev-credential).

Keep GitHub secret scanning, push protection and dependency vulnerability alerts
enabled. Review active workflows after upstream synchronization, especially
scheduled jobs and jobs with write permissions. Enable only the workflows
required for this fork. Root-level runtime copies, database and private-key
exports are ignored; this does not cover arbitrary export names or remove
existing history. Keep runtime profiles, authentication files and user databases
outside build inputs. Artifact signature and revision verification does not
replace a secret scan or verification of the changed behavior.

Standard GitHub-hosted runner use is free for public repositories. Private
repositories consume the owner's included allowance, with charges beyond it;
artifact storage also has an allowance. See [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
Short retention and manual runs limit usage but do not enforce a spending cap.
For a private repository, configure the owner's Actions budget before running.
