#!/usr/bin/env bash
# Installs this checkout into CanvasTTY's plugin folder. Run it while CanvasTTY is closed:
# the app rewrites plugins.json while it runs.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
config="${CANVASTTY_USER_DATA_DIR:-$HOME/.config/canvastty}"
id="$(node -p "require('$here/canvastty.plugin.json').id")"

if pgrep -x canvastty >/dev/null; then
  echo "CanvasTTY is running; close it first." >&2
  exit 1
fi

target="$config/plugins/$id"
mkdir -p "$target/services"
install -m 644 "$here/canvastty.plugin.json" "$target/canvastty.plugin.json"
install -m 644 "$here/services/auto-continue.mjs" "$target/services/auto-continue.mjs"

registry="$config/plugins.json"
[ -f "$registry" ] && cp -p "$registry" "$registry.bak-$(date +%Y%m%d%H%M%S)"
node - "$registry" "$id" <<'JS'
const fs = require('node:fs');
const [registry, id] = process.argv.slice(2);
let plugins = {};
try { plugins = JSON.parse(fs.readFileSync(registry, 'utf8')); } catch {}
plugins[id] = { ...(plugins[id] ?? {}), sourceUrl: 'https://github.com/tab11pm/canvastty-plugin-auto-continue', enabled: true,
  installedAt: plugins[id]?.installedAt ?? Date.now() };
// Trust is per entry hash: a changed auto-continue.mjs must be trusted again in Settings.
delete plugins[id].trustedServices;
fs.writeFileSync(registry, `${JSON.stringify(plugins, null, 2)}\n`, { mode: 0o600 });
JS
echo "Installed $id into $target."
echo "Start CanvasTTY, then Settings -> Agents -> Extension native code -> trust \"Auto Continue\"."
