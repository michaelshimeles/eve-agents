#!/usr/bin/env bash
# Mirrors apps/eve from the personal agent repo (boringcomputers/ruth).
#
# apps/eve is a verbatim copy of ruth's apps/eve plus two deterministic
# transforms; nothing in apps/eve is ever edited by hand in this repo:
#   1. agent/instructions.md is replaced with a generic placeholder (the
#      builder generates per-agent instructions at deploy time, and the
#      personal instructions shouldn't ship in the product repo).
#   2. .eve-template-release is derived from ruth's commit count, giving
#      deployed agents a monotonic release number to order templates by.
#
# Run from anywhere inside the repo; leaves the mirror staged (git add).
set -euo pipefail

RUTH_REPO="${RUTH_REPO:-https://github.com/boringcomputers/ruth}"
RUTH_REF="${RUTH_REF:-main}"

root="$(git rev-parse --show-toplevel)"
cd "$root"

git fetch --quiet "$RUTH_REPO" "$RUTH_REF"
ruth_sha="$(git rev-parse FETCH_HEAD)"
# Count only commits touching apps/eve: monotonic, and stable when a ruth
# push doesn't change the template (no phantom "update available").
release="$(git rev-list --count FETCH_HEAD -- apps/eve)"

git rm -rq --ignore-unmatch apps/eve
git checkout FETCH_HEAD -- apps/eve

cp apps/builder/template-overrides/instructions.md apps/eve/agent/instructions.md
printf '%s\n' "$release" > apps/eve/.eve-template-release

git add -A apps/eve
echo "synced apps/eve to ${ruth_sha} (release ${release})"
