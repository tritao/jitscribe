#!/usr/bin/env bash
set -euo pipefail

# Bootstrap a source checkout on Ubuntu/Debian and make the jitscribe command
# available on PATH. The script is deliberately repeatable: rerunning it
# refreshes JavaScript dependencies from the lockfile while reusing an existing
# whisper build and downloaded models.

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
skip_system=0
skip_whisper=0
no_link=0
dry_run=0

usage() {
  cat <<'EOF'
Usage: scripts/bootstrap.sh [options]

Install system prerequisites, JavaScript dependencies, the pinned whisper.cpp
worker/models, and a globally linked jitscribe command.

Options:
  --skip-system   Do not run apt-get; only build the project
  --skip-whisper  Do not build/download whisper.cpp and its models
  --no-link       Do not run npm link
  --dry-run       Print the commands that would be run
  -h, --help      Show this help
EOF
}

die() {
  printf 'bootstrap: %s\n' "$1" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-system) skip_system=1 ;;
    --skip-whisper) skip_whisper=1 ;;
    --no-link) no_link=1 ;;
    --dry-run) dry_run=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (use --help)" ;;
  esac
  shift
done

run() {
  if (( dry_run )); then
    printf '+ '
    printf '%q ' "$@"
    printf '\n'
  else
    "$@"
  fi
}

if [[ "${OSTYPE:-}" != linux* ]]; then
  die "this bootstrap currently supports Linux only"
fi

if (( !skip_system )); then
  command -v apt-get >/dev/null 2>&1 || die "apt-get is required (use --skip-system if dependencies are already installed)"
  apt=(apt-get)
  if (( EUID != 0 )); then
    command -v sudo >/dev/null 2>&1 || die "sudo is required to install system packages"
    apt=(sudo apt-get)
    if (( !dry_run )); then
      sudo -v
    fi
  fi
  run "${apt[@]}" update
  run "${apt[@]}" install -y build-essential ca-certificates cmake curl ffmpeg git libpulse0 pulseaudio-utils
fi

if (( !dry_run )); then
  command -v node >/dev/null 2>&1 || die "Node.js 22 or newer is required; install it from https://nodejs.org/"
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$node_major" =~ ^[0-9]+$ ]] || die "could not determine the Node.js version"
  (( node_major >= 22 )) || die "Node.js 22 or newer is required (found $(node --version))"
  command -v npm >/dev/null 2>&1 || die "npm is required (it is normally included with Node.js)"

  browser=""
  for candidate in chromium chromium-browser google-chrome google-chrome-stable; do
    if command -v "$candidate" >/dev/null 2>&1; then
      browser="$candidate"
      break
    fi
  done
  [[ -n "$browser" ]] || die "Chromium or Google Chrome is required; install one, then rerun bootstrap"
fi

cd "$project_dir"
run npm ci
if (( !skip_whisper )); then
  run npm run setup:whisper
fi
run npm run build
if (( !no_link )); then
  run npm link
fi

if (( !dry_run )); then
  printf '\nBootstrap complete. Try:\n  jitscribe --help\n'
fi
