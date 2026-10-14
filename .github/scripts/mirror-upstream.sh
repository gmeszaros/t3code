#!/bin/bash
set -euo pipefail

upstream_repo="${1:?Usage: mirror-upstream.sh <upstream-repository> <destination-repository>}"
destination_repo="${2:?Missing destination repository}"
mirror_ref=refs/heads/upstream/main
latest_sha="$(git ls-remote --exit-code "$upstream_repo" refs/heads/main | cut -f1)"
current_sha=""
if current_ref="$(git ls-remote --exit-code "$destination_repo" "$mirror_ref")"; then
  current_sha="${current_ref%%$'\t'*}"
else
  status=$?
  if [ "$status" -ne 2 ]; then
    exit "$status"
  fi
fi

scratch_dir="$(mktemp -d "${TMPDIR:-/tmp}/t3code-upstream-mirror.XXXXXX")"
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
    } >> "$GITHUB_OUTPUT"
  fi
  echo "Upstream mirror: $1; revision $latest_sha"
}

if [ -n "$current_sha" ]; then
  git_at fetch --quiet --no-tags "$destination_repo" "$mirror_ref"
  if [ "$latest_sha" = "$current_sha" ]; then
    record_result false
    exit 0
  fi
fi

git_at fetch --quiet --no-tags "$upstream_repo" refs/heads/main
latest_sha="$(git_at rev-parse FETCH_HEAD)"
if [ -n "$current_sha" ] && ! git_at merge-base --is-ancestor "$current_sha" "$latest_sha"; then
  echo 'Upstream history diverged or moved backwards. The existing mirror was preserved.' >&2
  exit 1
fi

git_at push --quiet "$destination_repo" "$latest_sha:$mirror_ref"
record_result true
