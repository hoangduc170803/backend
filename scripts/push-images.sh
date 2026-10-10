#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

NAMESPACE="${DOCKERHUB_NAMESPACE:-aubot}"

SERVICES=(
  "wes-opentcs:OPENTCS_TAG:../opentcs-integration-FMS"
  "wes-be:BE_TAG:."
  "wes-fe:FE_TAG:../wes-client-v2"
  "wes-simulator:SIMULATOR_TAG:../AgvSimulator"
)

wanted=("$@")
selected() {
  [[ ${#wanted[@]} -eq 0 ]] && return 0
  local s
  for s in "${wanted[@]}"; do [[ "$s" == "$1" ]] && return 0; done
  return 1
}

release_lines=()

for entry in "${SERVICES[@]}"; do
  IFS=: read -r image tag_var repo <<< "$entry"

  selected "$image" || continue

  if ! sha="$(git -C "$repo" rev-parse --short HEAD 2>/dev/null)"; then
    echo "!! $image: $repo is not a git repository" >&2
    exit 1
  fi

  if ! git -C "$repo" -c core.autocrlf=true diff --quiet HEAD -- 2>/dev/null; then
    echo "!! $image: $repo has uncommitted changes; $sha will not describe the image" >&2
    [[ "${ALLOW_DIRTY:-0}" == "1" ]] || exit 1
  fi

  if ! docker image inspect "$image:latest" >/dev/null 2>&1; then
    echo "!! $image:latest not built; run: docker compose -f compose.build.yml build" >&2
    exit 1
  fi

  for tag in latest "$sha"; do
    target="$NAMESPACE/$image:$tag"
    echo "==> $image:latest -> $target"
    docker tag "$image:latest" "$target"
    docker push "$target"
  done
  release_lines+=("$tag_var=$sha")
done

echo
echo "Paste into deploy/releases/<env>.env:"
printf '%s\n' "${release_lines[@]}"
