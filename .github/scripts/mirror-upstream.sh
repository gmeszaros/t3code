#!/bin/bash
set -euo pipefail

upstream_repo="${1:?Usage: mirror-upstream.sh <upstream-repository> <destination-repository>}"
destination_repo="${2:?Missing destination repository}"
mirror_ref=refs/heads/upstream/main
main_ref=refs/heads/main
scratch_dir="$(mktemp -d "${TMPDIR:-/tmp}/t3code-upstream-rebase.XXXXXX")"
trap 'rm -rf "$scratch_dir"' EXIT
git init --quiet "$scratch_dir"

git_at() {
  git -C "$scratch_dir" -c credential.helper= -c 'credential.helper=!gh auth git-credential' "$@"
}

record_result() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
      echo "changed=$1"
      echo "upstream_sha=$latest_sha"
      echo "main_sha=$rebased_main"
    } >> "$GITHUB_OUTPUT"
  fi
  echo "Upstream rebase: $1; upstream $latest_sha; Local main $rebased_main"
}

git_at fetch --quiet --no-tags "$destination_repo" "$main_ref:refs/heads/local-main" "$mirror_ref:refs/heads/upstream-base"
current_main="$(git_at rev-parse local-main)"
current_sha="$(git_at rev-parse upstream-base)"
git_at fetch --quiet --no-tags "$upstream_repo" refs/heads/main
latest_sha="$(git_at rev-parse FETCH_HEAD)"

if ! git_at merge-base --is-ancestor "$current_sha" "$latest_sha"; then
  echo 'Upstream history diverged or moved backwards. Both branches were preserved.' >&2
  exit 1
fi
if ! git_at merge-base --is-ancestor "$current_sha" "$current_main"; then
  echo 'Local main is not based on the tracked upstream revision. Both branches were preserved.' >&2
  exit 1
fi
if [ -n "$(git_at rev-list --merges "$current_sha..$current_main")" ]; then
  echo 'Local main contains merge commits. Use squash or rebase merges for Local pull requests.' >&2
  exit 1
fi
rebased_main="$current_main"
if [ "$latest_sha" = "$current_sha" ]; then
  record_result false
  exit 0
fi

git_at config user.name 'Local upstream sync'
git_at config user.email 'local-upstream-sync@users.noreply.github.com'
git_at checkout --quiet local-main
if ! git_at -c core.hooksPath=/dev/null rebase --onto "$latest_sha" "$current_sha" local-main; then
  git_at rebase --abort
  echo 'Local rebase conflicted. Both branches were preserved. Resolve the update in a feature worktree.' >&2
  exit 1
fi
rebased_main="$(git_at rev-parse HEAD)"
git_at merge-base --is-ancestor "$latest_sha" "$rebased_main"
git_at diff --check "$latest_sha" "$rebased_main"

git_at push --quiet --atomic \
  "--force-with-lease=$main_ref:$current_main" \
  "--force-with-lease=$mirror_ref:$current_sha" \
  "$destination_repo" \
  "$latest_sha:$mirror_ref" \
  "$rebased_main:$main_ref" \
  "$current_main:refs/tags/local-rebase/$current_main"
record_result true
