#!/bin/sh
# Installs one tool lntt drives, at the version under test, and what its upstream test
# needs at the latest. For Orca and Herdr: the real `claude` from npm, which stops at its
# welcome screen when not logged in and which both detect as a ready agent, and opencode
# for the agent started by a shell command. Used by the Upstream tools workflow
# (.github/workflows/upstream.yml) and by a run in a container.
# It installs system packages and writes to /usr/local/bin, so it runs only on a
# throwaway machine: a GitHub runner or a container (docs/process/ci.md).
#
# Usage: scripts/upstream-install.sh <orca|herdr|claude|opencode> <version>

set -eu
tool=${1:?usage: upstream-install.sh <orca|herdr|claude|opencode> <version>}
version=${2:?usage: upstream-install.sh <orca|herdr|claude|opencode> <version>}

if [ "${GITHUB_ACTIONS:-}" != true ] && [ ! -f /.dockerenv ]; then
  echo "upstream-install: installs system packages; run it on a GitHub runner or in a container" >&2
  exit 1
fi
sudo=''
[ "$(id -u)" = 0 ] || sudo=sudo
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# The release asset, checked against the sha256 GitHub records for it. GH_TOKEN, when
# set, lifts the API's limit for anonymous calls, which a shared runner IP can reach.
fetch() { # <owner/repo> <asset> <file>
  curl -fsSL --retry 3 -o "$3" "https://github.com/$1/releases/download/v$version/$2"
  auth=''
  [ -z "${GH_TOKEN:-}" ] || auth="Authorization: Bearer $GH_TOKEN"
  digest=$(curl -fsSL --retry 3 ${auth:+-H "$auth"} "https://api.github.com/repos/$1/releases/tags/v$version" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).assets.find(a=>a.name===process.argv[1]);console.log(a?.digest??"")})' "$2")
  case $digest in
    sha256:*) echo "${digest#sha256:}  $3" | sha256sum -c - ;;
    *) echo "upstream-install: no digest for $2 in the release, so it is not installed unverified" >&2; exit 1 ;;
  esac
}

# npm's global prefix is writable without sudo: setup-node's on the runner, root's in a
# container.
claude_latest() {
  npm install -g --silent @anthropic-ai/claude-code@latest
}

# Homebrew installs only the current stable. The runner's Homebrew is not on the PATH.
opencode_latest() {
  brew=/home/linuxbrew/.linuxbrew/bin/brew
  HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ENV_HINTS=1 $brew install --quiet opencode
  $sudo ln -sf "$($brew --prefix)/bin/opencode" /usr/local/bin/opencode
}

case $(uname -m) in
  x86_64 | amd64) deb=amd64 bin=x86_64 ;;
  aarch64 | arm64) deb=arm64 bin=aarch64 ;;
  *) echo "upstream-install: no build for $(uname -m)" >&2; exit 1 ;;
esac

case $tool in
  orca)
    fetch stablyai/orca "orca-ide_${version}_$deb.deb" "$work/orca.deb"
    # Electron's libraries: without them the binary stops on libasound.so.2.
    $sudo apt-get update -qq
    $sudo apt-get install -y -qq --no-install-recommends "$work/orca.deb" \
      libasound2t64 libgtk-3-0t64 libnss3 libgbm1 libxss1 libxshmfence1 libdrm2 >/dev/null
    # The package installs `orca-ide`; lntt calls `orca`.
    command -v orca >/dev/null || $sudo ln -sf "$(command -v orca-ide)" /usr/local/bin/orca
    claude_latest
    opencode_latest
    ;;
  herdr)
    fetch herdrdev/herdr "herdr-linux-$bin" "$work/herdr"
    $sudo install -m 755 "$work/herdr" /usr/local/bin/herdr
    claude_latest
    opencode_latest
    ;;
  claude)
    npm install -g --silent "@anthropic-ai/claude-code@$version"
    ;;
  opencode)
    opencode_latest
    ;;
  *)
    echo "upstream-install: unknown tool $tool; the tools are orca, herdr, claude, opencode" >&2
    exit 2
    ;;
esac

# What is on the PATH now is the version asked for, or the check would test another.
case $tool in
  orca) installed=$(dpkg-query -W -f '${Version}' orca-ide) ;;
  herdr) installed=$(herdr --version) ;;
  claude) installed=$(claude --version) ;;
  opencode) installed=$(opencode --version) ;;
esac
# One word of the tool's version line is the version exactly (a leading v aside), so
# 1.2.30 or 1.2.3-rc.1 do not pass for 1.2.3.
for word in $installed; do
  if [ "${word#v}" = "$version" ]; then
    echo "upstream-install: $tool $version"
    exit 0
  fi
done
# Homebrew installs only its current stable: when it moved on since the version was read,
# the job checks the one installed, under that version's name (its issue, its cache
# entry), rather than going red for one it never installed.
if [ "$tool" = opencode ] && [ -n "${GITHUB_ENV:-}" ]; then
  for word in $installed; do now=${word#v}; done
  echo "::notice::Homebrew installs opencode $now, read as $version; checking $now"
  echo "VERSION=$now" >> "$GITHUB_ENV"
  exit 0
fi
echo "upstream-install: asked for $tool $version, installed $installed" >&2
exit 1
