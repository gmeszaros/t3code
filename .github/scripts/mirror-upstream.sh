#!/bin/bash
set -euo pipefail

upstream_repo="${1:?Usage: mirror-upstream.sh <upstream-repository> <destination-repository>}"
destination_repo="${2:?Missing destination repository}"
snapshot_ref=refs/heads/upstream-snapshot
latest_sha="$(git ls-remote --exit-code "$upstream_repo" refs/heads/main | cut -f1)"
current_sha=""
if current_ref="$(git ls-remote --exit-code "$destination_repo" "$snapshot_ref")"; then
  current_sha="${current_ref%%$'\t'*}"
else
  status=$?
  if [ "$status" -ne 2 ]; then
    exit "$status"
  fi
fi

scratch_dir="$(mktemp -d "${TMPDIR:-/tmp}/t3code-upstream-snapshot.XXXXXX")"
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
  echo "Upstream snapshot: $1; revision $latest_sha"
}

previous_upstream_sha=""
if [ -n "$current_sha" ]; then
  git_at fetch --quiet --no-tags "$destination_repo" "$snapshot_ref"
  previous_upstream_sha="$(git_at log -1 --format=%B "$current_sha" | sed -n 's/^Upstream-Commit: //p')"
  if [[ ! "$previous_upstream_sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo 'The existing snapshot has no valid upstream revision. It was preserved.' >&2
    exit 1
  fi
  if [ "$latest_sha" = "$previous_upstream_sha" ]; then
    record_result false
    exit 0
  fi
fi

git_at fetch --quiet --no-tags "$upstream_repo" refs/heads/main
latest_sha="$(git_at rev-parse FETCH_HEAD)"
if [ -n "$previous_upstream_sha" ] && ! git_at merge-base --is-ancestor "$previous_upstream_sha" "$latest_sha"; then
  echo 'Upstream history diverged or moved backwards. The existing snapshot was preserved.' >&2
  exit 1
fi

git_at read-tree "$latest_sha"
git_at ls-files -z -- .github | git_at update-index --force-remove -z --stdin
snapshot_tree="$(git_at write-tree)"
parents=()
if [ -n "$current_sha" ]; then
  parents=(-p "$current_sha")
fi
snapshot_sha="$(printf 'chore(upstream): snapshot main without workflow files\n\nUpstream-Commit: %s\n' "$latest_sha" |
  git_at -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' commit-tree "$snapshot_tree" "${parents[@]}")"
git_at push --quiet "$destination_repo" "$snapshot_sha:$snapshot_ref"
record_result true
