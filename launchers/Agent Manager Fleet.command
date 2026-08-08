#!/bin/zsh
source "$HOME/.zprofile" 2>/dev/null

if ! command -v agent-manager-fleet >/dev/null 2>&1; then
  echo "agent-manager-fleet is not on PATH. Install Agent Manager with npm link or npm install -g."
  read -r "?Press Return to close."
  exit 1
fi

exec agent-manager-fleet "$@"
