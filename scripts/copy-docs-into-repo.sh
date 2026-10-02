#!/usr/bin/env bash
set -euo pipefail

# Run this script from the folder that contains snacky-os.
# Example:
#   cd ~/Desktop/Snacky
#   bash snacky-repo-docs-pack/scripts/copy-docs-into-repo.sh snacky-os

REPO_DIR="${1:-snacky-os}"
PACK_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -d "$REPO_DIR" ]; then
  echo "Repo directory not found: $REPO_DIR"
  exit 1
fi

mkdir -p "$REPO_DIR/docs"
cp "$PACK_DIR/AGENTS.md" "$REPO_DIR/AGENTS.md"
cp "$PACK_DIR/docs/"*.md "$REPO_DIR/docs/"
cp "$PACK_DIR/docs/"*.csv "$REPO_DIR/docs/"

echo "Snacky repo docs copied into $REPO_DIR"
