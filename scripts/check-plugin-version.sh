#!/bin/sh
# A change under plugins/<name>/ must raise that plugin's version: an installed plugin
# is updated only when its version changes, so a new or edited skill with the same
# version never reaches the projects that installed the plugin.
#
# Usage: scripts/check-plugin-version.sh <base-ref>   (e.g. origin/main)

set -eu
base=${1:?usage: check-plugin-version.sh <base-ref>}
status=0

for manifest in plugins/*/.claude-plugin/plugin.json; do
  dir=${manifest%/.claude-plugin/plugin.json}
  git diff --quiet "$base"...HEAD -- "$dir" && continue
  old=$(git show "$base:$manifest" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version)}catch{console.log("")}})')
  new=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$manifest")
  if [ -n "$old" ] && [ "$old" = "$new" ]; then
    echo "::error file=$manifest::$dir changed but its version is still $new; raise it, or installed copies will not update"
    status=1
  fi
done
exit $status
