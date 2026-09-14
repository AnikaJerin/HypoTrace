#!/bin/zsh
set -euo pipefail

read -rs "HYPOTRACE_SECRET?Paste your OpenAI API key: "
echo
if [[ -z "$HYPOTRACE_SECRET" ]]; then
  echo "No key entered; nothing was stored."
  exit 1
fi

/usr/bin/security add-generic-password -U -a "$USER" -s "HypoTrace.OpenAI" -w "$HYPOTRACE_SECRET" >/dev/null
unset HYPOTRACE_SECRET
echo "Saved in macOS Keychain. Future runs can use: python3 backend/server.py"
