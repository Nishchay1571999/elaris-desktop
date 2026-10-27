#!/usr/bin/env bash
# Clones and updates the Elaris repos. The same file ships in every repo, so
# whichever one you cloned first can fetch the rest.
#
#   scripts/elaris-repos.sh list             what exists and what's cloned
#   scripts/elaris-repos.sh clone [name...]  clone missing repos (default: all)
#   scripts/elaris-repos.sh pull             git pull --ff-only in each clone
#   scripts/elaris-repos.sh status           git status of each clone
#
# Layout: the `elaris` workspace repo is the root and each app repo lives at
# apps/<name>, ignored by the workspace's git. Run from a standalone app clone,
# `clone` first clones the workspace next to it (../elaris) and fills that in.
#
# Repos you can't access (private ones, for outside contributors) are skipped
# with a warning. Point at another host or account with ELARIS_GIT_BASE.
set -euo pipefail

base="${ELARIS_GIT_BASE:-git@github.com:Nishchay1571999}"

# name  path-in-workspace  repo
repos="workspace . elaris
desktop apps/desktop elaris-desktop
web apps/web elaris-web"

here="$(cd "$(dirname "$0")/.." && pwd)"
root="$here"
while [ "$root" != "/" ] && [ ! -f "$root/.elaris-workspace" ]; do root="$(dirname "$root")"; done
[ "$root" = "/" ] && root=""

each() {
  echo "$repos" | while read -r name path repo; do "$@" "$name" "$path" "$repo"; done
}

dir_of() {
  if [ "$1" = . ]; then echo "$root"; else echo "$root/$1"; fi
}

show() {
  local dir state="not cloned"
  dir="$(dir_of "$2")"
  [ -n "$root" ] && [ -e "$dir/.git" ] && state="$dir"
  printf '%-10s %-22s %s\n' "$1" "$3" "$state"
}

clone_one() {
  local name="$1" repo="$3" dir
  dir="$(dir_of "$2")"
  if [ -e "$dir/.git" ]; then echo "$name: already at $dir"; return; fi
  echo "$name: cloning $base/$repo.git into $dir"
  git clone "$base/$repo.git" "$dir" || echo "$name: skipped (no access or not found)" >&2
}

wanted() {
  [ -z "${want:-}" ] || [[ " $want " == *" $1 "* ]]
}

cmd="${1:-list}"; shift || true
case "$cmd" in
  list)
    [ -z "$root" ] && echo "Not inside the Elaris workspace; \`clone\` will create it at $(dirname "$here")/elaris"
    each show ;;
  clone)
    if [ -z "$root" ]; then
      root="$(dirname "$here")/elaris"
      clone_one workspace . elaris
      [ -f "$root/.elaris-workspace" ] || { echo "Couldn't clone the workspace repo" >&2; exit 1; }
      echo "Workspace is at $root. This standalone clone ($here) can be deleted once you've moved over."
    fi
    want="$*"
    echo "$repos" | while read -r name path repo; do
      [ "$name" = workspace ] && continue
      if wanted "$name"; then clone_one "$name" "$path" "$repo"; fi
    done ;;
  pull|status)
    [ -z "$root" ] && { echo "Not inside the Elaris workspace" >&2; exit 1; }
    echo "$repos" | while read -r name path repo; do
      dir="$(dir_of "$path")"
      [ -e "$dir/.git" ] || continue
      echo "== $name"
      if [ "$cmd" = pull ]; then git -C "$dir" pull --ff-only; else git -C "$dir" status -sb; fi
    done ;;
  *)
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
