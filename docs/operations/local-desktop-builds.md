# Local desktop builds on GitHub

## Repository decision (2026-10-14)

Keep `gmeszaros/t3code-local` as a standalone public shadow repository. Its `upstream/main` branch mirrors the original `pingdotgg/t3code` commits and complete trees. The custom `main` preserves Local changes and integrates upstream through merge commits. GitHub fork conversion is unnecessary for this history model.

Existing published commits, tags and releases remain intact. The initial ancestry repair merges the already-integrated upstream revision without changing source files. The old `upstream-snapshot` branch remains a historical reference and is no longer updated.

## Build, release and synchronization workflow

Local packaging and CI use the same command: `node scripts/build-local-desktop.mjs`.
It assigns one UTC date-and-time version, aligns package versions, builds the ZIP,
verifies the signature and shipped backend, and writes the checksum manifest.
Package versions and a temporary public `.env` are restored on success or failure.
Use `--output-dir <directory>` to keep artifacts outside the checkout.

### Upstream integration

Start in a clean feature worktree based on the current Local `main`. Fetch the original upstream history and merge it with `git merge --no-ff upstream/main`. Review workflow conflicts explicitly so Local build settings survive. Inspect the diff, run scoped checks, and prepare a draft PR against Local `main`.

After publication approval, merge the PR with `gh pr merge --merge`. **Use a merge commit for upstream integration. Squash and rebase merges discard the ancestry this repository preserves.** Verify that the integrated upstream SHA is an ancestor of the final hosted `main`. `git log main..upstream/main` lists pending upstream commits, and `git diff upstream/main...main` shows the Local delta after integration.

The build fetches upstream main and records its real merge base with the source revision. An explicit `--upstream-sha <sha>` must also be an ancestor of that source. Keep build, publication and installation in one update round. One final publication approval covers the reviewed branch, PR merge and release. Install only after active runs finish.

The `Local desktop build` workflow builds a self-contained macOS arm64 app on
the standard `macos-15` runner. It runs only through `workflow_dispatch` and
uploads a ZIP and build manifest for one day. The optional **Publish release** input publishes a verified manual-download release when building `main`. Branch builds never publish. The app checks the latest published Local release and opens its download page from the sidebar update icon or Settings. It never replaces the app automatically. Release assets remain available after Actions artifacts expire.

Add the workflow to your own GitHub repository's default branch, then select
**Actions > Local desktop build > Run workflow** and choose the branch to build. To publish, select `main` and enable **Publish release**. After packaging verification, the workflow uploads the ZIP and manifest to a draft release and publishes it as latest. An existing tag is never overwritten.
When importing a fork, review its inherited workflows before enabling Actions;
upstream release workflows are not configured for this personal build.

Enable only `Local desktop build` and `Mirror upstream` in the personal repository. The mirror job checks upstream main every Monday at 07:17 UTC and can also run manually. It fast-forwards `upstream/main` to the exact original SHA, including `.github`. It leaves custom `main` unchanged and does not build or release the app.

Unchanged revisions create no commit. Divergent or backwards upstream history stops without updating the mirror. Pushes never use force. Keep inherited upstream workflows disabled.

The scheduled job uses the built-in `GITHUB_TOKEN` with Contents write access. GitHub can reject a push that introduces workflow-file changes without workflow-write authorization. If that happens, leave the mirror unchanged and run the same script with an approved workflow-capable GitHub credential. Do not replace original commits with filtered snapshots. The locally authenticated `gh` credential can run `bash .github/scripts/mirror-upstream.sh https://github.com/pingdotgg/t3code.git https://github.com/gmeszaros/t3code-local.git` after approval for the remote update.

The Linux job needs no dependencies, caches or artifacts. The macOS job runs only on demand. GitHub schedules may be delayed, and public scheduled workflows may need re-enabling after 60 days without repository activity.

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
