#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_DIR}"

if ! command -v code >/dev/null 2>&1; then
    echo "Error: 'code' not found in PATH. Open the command palette in VS Code and run" >&2
    echo "'Shell Command: Install code command in PATH' to add it." >&2
    exit 1
fi

VERSION="$(node -pe "require('./package.json').version")"
VSIX_NAME="claude-token-status-${VERSION}.vsix"

echo "==> Packaging claude-token-status ${VERSION}"
rm -f ./*.vsix
npx --yes @vscode/vsce package --allow-missing-repository

echo "==> Installing ${VSIX_NAME} into VS Code"
code --install-extension "${VSIX_NAME}"

echo "==> Done. Run 'Developer: Reload Window' in VS Code to reload the extension."
