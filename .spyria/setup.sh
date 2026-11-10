#!/bin/sh
set -eu
[ "$(bun --version 2>/dev/null)" = 1.4.4 ] || npm install --global --prefix "$HOME/.local" bun@1.4.4
bun install --frozen-lockfile
