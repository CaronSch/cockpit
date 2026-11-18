#!/bin/sh
# Installs Cockpit and what it needs, in one line:
#
#   curl -fsSL https://raw.githubusercontent.com/CaronSch/cockpit/main/install.sh | sh
#
# - Bun (1.3.14 or later), which runs the daemon, unless a recent enough one is there.
# - omp, the coding agent every Agent window runs, unless one is there (omp's own installer, into
#   ~/.local/bin, where the daemon also looks when omp is not on its PATH).
# - Cockpit itself: cloned into $COCKPIT_DIR (default ~/cockpit), then `bun install`. An existing
#   checkout is kept as it is (the workbench's Update brings it up to date).
# - omp's global instructions: an empty ~/.omp/agent/AGENTS.md becomes the one line
#   `@~/.claude/CLAUDE.md`, so omp and Claude Code follow the same file (created empty if there
#   is none). One with instructions of its own is left alone.
#
# Running it again repairs what is missing and changes nothing else. A model provider, GitHub and
# the phone are set up afterwards, in the workbench's Setup window.
set -eu

REPO=https://github.com/CaronSch/cockpit.git
BUN_MIN=1.3.14
DIR=${COCKPIT_DIR:-$HOME/cockpit}
OMP_AGENT_DIR=${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}
CLAUDE_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude}

say() { printf '%s\n' "$*"; }
fail() {
  printf 'cockpit install: %s\n' "$*" >&2
  exit 1
}
# $1 as written with ~ for the home directory.
tilde() { case $1 in "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;; *) printf '%s' "$1" ;; esac; }
# Whether version $1 is at least $2 (both x.y.z).
at_least() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -n1)" = "$2" ]
}

command -v curl >/dev/null 2>&1 || fail 'curl is needed'
# On a Mac without the command line tools, git is a stub that offers to install them.
git --version >/dev/null 2>&1 || fail 'git is needed: on a Mac, run xcode-select --install, then run this again'

# Bun
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
if command -v bun >/dev/null 2>&1 && at_least "$(bun --version)" "$BUN_MIN"; then
  say "✓ Bun $(bun --version)"
elif command -v bun >/dev/null 2>&1; then
  say "Bun $(bun --version) is older than $BUN_MIN: upgrading"
  bun upgrade
else
  say 'Installing Bun'
  curl -fsSL https://bun.sh/install | bash
fi

# omp
if command -v omp >/dev/null 2>&1; then
  say "✓ $(omp --version)"
else
  say 'Installing omp'
  curl -fsSL https://omp.sh/install | sh
fi

# Cockpit
if [ -d "$DIR/.git" ]; then
  say "✓ Cockpit at $(tilde "$DIR")"
elif [ -e "$DIR" ]; then
  fail "$(tilde "$DIR") exists and is not a git checkout: set COCKPIT_DIR to another directory"
else
  say "Cloning Cockpit into $(tilde "$DIR")"
  git clone --quiet "$REPO" "$DIR"
fi
(cd "$DIR" && bun install --silent)

# omp follows Claude Code's global instructions
agents=$OMP_AGENT_DIR/AGENTS.md
claude=$CLAUDE_DIR/CLAUDE.md
pointer="@$(tilde "$claude")"
if [ -s "$agents" ] && grep -qxF "$pointer" "$agents"; then
  say "✓ omp follows $(tilde "$claude")"
elif [ -s "$agents" ]; then
  say "! $(tilde "$agents") has instructions of its own, so it is left as it is."
  say "  To share Claude Code's, move them into $(tilde "$claude") and make that file the line $pointer"
else
  mkdir -p "$OMP_AGENT_DIR" "$CLAUDE_DIR"
  [ -e "$claude" ] || : >"$claude"
  printf '%s\n' "$pointer" >"$agents"
  say "✓ omp now follows $(tilde "$claude")"
fi

say ''
say "Start Cockpit, and open the address it prints:"
say ''
say "  cd $(tilde "$DIR") && bun start"
