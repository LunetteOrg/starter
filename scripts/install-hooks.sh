#!/bin/sh
# `prepare`: install the git hooks so every worktree keeps finding lefthook.
#
# Git hooks live in the common dir, shared by every worktree. `lefthook install`
# bakes into each hook the absolute, versioned path of the binary it ran from:
#
#     elif /abs/node_modules/.pnpm/lefthook-darwin-arm64@2.1.10/.../bin/lefthook -h
#
# That path breaks when lefthook is upgraded, or when the install ran in a worktree
# that is later deleted. A new worktree has no node_modules when git runs
# `post-checkout`, so the hook then falls through its runner list down to
# `swift package lefthook`, which leaves a `.build/` folder behind and runs nothing.
#
# This script installs with the main checkout's binary and rewrites that path to
# `<main checkout>/node_modules/.bin/lefthook`: the name survives upgrades, and the
# main checkout is the one tree that stays. Run from a worktree, it still targets
# the main checkout. `no_auto_install` in lefthook.yml stops lefthook from
# rewriting the hooks on its own.
#
# A missing lefthook must not fail `pnpm install`: the caller adds `|| true`.

set -u

common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
case "$common" in
  */.git) main=${common%/.git} ;;
  *)
    echo "install-hooks: git dir $common is not <checkout>/.git; hooks left as they are" >&2
    exit 0
    ;;
esac

bin="$main/node_modules/.bin/lefthook"
if [ ! -x "$bin" ]; then
  echo "install-hooks: $bin not found; run pnpm install in $main first" >&2
  exit 1
fi

(cd "$main" && "$bin" install) || exit $?

hooks=$(git -C "$main" rev-parse --path-format=absolute --git-path hooks)
for hook in "$hooks"/*; do
  [ -f "$hook" ] || continue
  grep -q 'call_lefthook' "$hook" || continue
  sed -i.bak -E "s#/[^ \"]*/node_modules/\\.pnpm/lefthook-[^/]+/node_modules/lefthook-[^/]+/bin/lefthook#$bin#g" "$hook" &&
    rm -f "$hook.bak"
done
