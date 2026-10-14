# Local desktop builds on GitHub

## Repository decision (2026-10-14)

Keep `gmeszaros/t3code-local` as a standalone public shadow repository. Its `upstream/main` branch tracks the original `pingdotgg/t3code` commits and complete trees. Custom `main` contains a linear series of Local commits above that revision. Upstream updates rebase this series automatically without an integration PR.

The initial migration replaces the former snapshot and merge history with equivalent Local commits above upstream. Preserve the old published tip under `archive/main-before-auto-rebase-20261014`. Existing tags, releases and the historical `upstream-snapshot` branch remain intact.

## Build, release and synchronization workflow

Local packaging and CI use the same command: `node scripts/build-local-desktop.mjs`.
It assigns one UTC date-and-time version, aligns package versions, builds the ZIP,
verifies the signature and shipped backend, and writes the checksum manifest.
Package versions and a temporary public `.env` are restored on success or failure.
Use `--output-dir <directory>` to keep artifacts outside the checkout.

### Local changes and upstream updates

Create feature worktrees from the latest hosted Local `main` and open feature PRs against `main`. These PRs show only their own changes. Merge Local PRs using squash or rebase merge to keep the patch series linear. Merge commits are rejected by the upstream updater.

The weekly `Mirror upstream` job fetches exact upstream history, rebases only commits between the tracked upstream SHA and Local `main`, and atomically updates both branches with explicit `force-with-lease` expectations. It retains the previous Local tip under `local-rebase/<old-main-sha>` tags. Unchanged upstream creates no commit or tag.

Conflicts, divergent upstream history, non-linear Local history, rejected pushes, or concurrent branch updates leave both hosted branches unchanged. For a conflict, fetch both repositories in a clean feature worktree, rebase the Local series onto the new upstream revision, resolve and validate it, then obtain approval for the exact replacement tips before retrying an atomic leased push. Do not merge upstream into Local `main`.

After an automatic update, feature branches may need rebasing onto the new Local `main`. For an existing clean checkout, save any work and use `git rebase --onto github/main <previous-local-main> <feature-branch>`. Use the recorded old tip from the sync log or backup tag. This prevents replaying the old Local series as feature changes.

The build fetches upstream main and records its real merge base with the source revision. An explicit `--upstream-sha <sha>` must also be an ancestor of that source. Keep build, publication and installation in one update round. One final publication approval covers the reviewed feature branch, PR merge and release. Install only after active runs finish.

The `Local desktop build` workflow builds a self-contained macOS arm64 app on
the standard `macos-15` runner. It runs only through `workflow_dispatch` and
uploads a ZIP and build manifest for one day. The optional **Publish release** input publishes a verified manual-download release when building `main`. Branch builds never publish. The app checks the latest published Local release and opens its download page from the sidebar update icon or Settings. It never replaces the app automatically. Release assets remain available after Actions artifacts expire.

Add the workflow to your own GitHub repository's default branch, then select
**Actions > Local desktop build > Run workflow** and choose the branch to build. To publish, select `main` and enable **Publish release**. After packaging verification, the workflow uploads the ZIP and manifest to a draft release and publishes it as latest. An existing tag is never overwritten.
When importing a fork, review its inherited workflows before enabling Actions;
upstream release workflows are not configured for this personal build.

Enable only `Local desktop build` and `Mirror upstream` in the personal repository. The updater runs every Monday at 07:17 UTC and can also run manually. It does not build or release the app. Keep inherited upstream workflows disabled.

Configure repository secret `UPSTREAM_SYNC_TOKEN` with a workflow-capable credential restricted to this repository. A fine-grained token needs Contents and Workflows write access. The updater stops before mutation if the secret is missing. The built-in `GITHUB_TOKEN` is insufficient for reliable synchronization of complete upstream workflow history. See [GitHub token permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens).

For an approved manual run, the locally authenticated `gh` credential can run `bash .github/scripts/mirror-upstream.sh https://github.com/pingdotgg/t3code.git https://github.com/gmeszaros/t3code-local.git`. This command also rewrites Local `main` and requires approval for that operation.

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
