#!/usr/bin/env bash
#
# Removes the launcher, desktop entry, and icons installed by
# scripts/install-desktop.sh. Application data in ~/.config/glm-studio and
# ~/.local/share/glm-studio is left alone; delete it by hand if you want a
# clean slate.

set -euo pipefail

SCOPE="user"
[[ "${1:-}" == "--system" ]] && SCOPE="system"

if [[ "$SCOPE" == "system" ]]; then
  BIN_DIR="/usr/local/bin"; DATA_DIR="/usr/share"
else
  BIN_DIR="${HOME}/.local/bin"; DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
fi

rm -f "${BIN_DIR}/glm-studio"
rm -f "${DATA_DIR}/applications/glm-studio.desktop"
for size in 16 24 32 48 64 128 256 512; do
  rm -f "${DATA_DIR}/icons/hicolor/${size}x${size}/apps/glm-studio.png"
done
rm -f "${DATA_DIR}/icons/hicolor/scalable/apps/glm-studio.svg"

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "${DATA_DIR}/applications" || true
command -v gtk-update-icon-cache  >/dev/null 2>&1 && gtk-update-icon-cache -f -t "${DATA_DIR}/icons/hicolor" >/dev/null 2>&1 || true

echo "==> GLM Studio launcher removed (${SCOPE} scope)."
echo "    Settings and credentials remain in ~/.config/glm-studio"
