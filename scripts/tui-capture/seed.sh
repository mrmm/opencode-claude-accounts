#!/usr/bin/env bash
# A throwaway $HOME for a real-TUI capture: one demo account, a seeded quota
# reading and OpenCode configured to load this checkout. Linux only: on macOS
# the plugin reads the login Keychain whatever $HOME says.
#
#   scripts/tui-capture/seed.sh <fake-home> <plugin-dir>
set -euo pipefail
home=$1
plugin=$(cd "$2" && pwd)
now=$(date +%s)

mkdir -p "$home/.claude" "$home/.config/opencode" \
  "$home/.local/share/opencode/claude-auth"

# Never a working token: the capture shows what the plugin draws from its
# cache, and any call it makes is refused.
cat >"$home/.claude/.credentials.json" <<EOF
{"claudeAiOauth":{"accessToken":"sk-ant-oat01-demo","refreshToken":"sk-ant-ort01-demo","expiresAt":$(((now + 30 * 86400) * 1000)),"scopes":["user:inference","user:profile"],"subscriptionType":"max"}}
EOF
echo '{"oauthAccount":{"emailAddress":"dev@example.com"}}' >"$home/.claude.json"

cat >"$home/.local/share/opencode/claude-auth/quota.json" <<EOF
{"file":{"fiveHour":{"utilization":0.42,"resetsAt":$((now + 2 * 3600 + 900))},"sevenDay":{"utilization":0.67,"resetsAt":$((now + 3 * 86400 + 5 * 3600))},"observedAt":$now}}
EOF

cat >"$home/.config/opencode/opencode.json" <<EOF
{"\$schema":"https://opencode.ai/config.json","plugin":["$plugin"],"autoupdate":false,"share":"disabled"}
EOF
cat >"$home/.config/opencode/tui.json" <<EOF
{"\$schema":"https://opencode.ai/tui.json","plugin":["$plugin/tui/claude-auth-tui.tsx"]}
EOF
# No probes: the demo token would only earn refusals and log noise.
echo '{"quotaProbe":false}' >"$home/.config/opencode/claude-auth.jsonc"
