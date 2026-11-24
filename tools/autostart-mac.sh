#!/bin/bash
# Автозапуск Вакиля при входе в Mac (и перезапуск, если он упадёт).
#   bash tools/autostart-mac.sh       — включить
#   bash tools/autostart-mac.sh off   — выключить
set -e
cd "$(dirname "$0")/.."
DIR="$(pwd)"
PLIST="$HOME/Library/LaunchAgents/local.wakil.plist"
LABEL="local.wakil"

if [ "$1" = "off" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Автозапуск выключен."
  exit 0
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
NODE="$(command -v node || true)"
[ -z "$NODE" ] && { echo "Не найден Node.js. Установите его с https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install --no-audit --no-fund
mkdir -p "$HOME/Library/LaunchAgents" data

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/src/main.mjs</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATH</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/data/autostart.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/autostart.log</string>
</dict></plist>
PL

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Готово: Вакиль запущен и будет сам запускаться при входе в Mac."
echo "Панель: http://localhost:8790   Выключить автозапуск: bash tools/autostart-mac.sh off"
