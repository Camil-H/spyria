#!/usr/bin/env bash
set -euo pipefail
chunks=$(mktemp -d)
split --line-bytes=8000 - "$chunks/"
for chunk in "$chunks"/*; do
  echo "::notice title=$1 $(basename "$chunk")::$(sed 's/%/%25/g' "$chunk" | sed ':a;N;$!ba;s/\n/%0A/g')"
done
