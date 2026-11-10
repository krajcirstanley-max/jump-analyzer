#!/bin/bash
# One-time setup: Modal login, app tokens, push keys, Claude tokens. Run it yourself in a
# terminal: the tokens go straight into Modal Secrets and never into a chat or a file in git.
# Usage: bash server/setup.sh you@example.com
set -euo pipefail
cd "$(dirname "$0")/.."
# `uv tool install modal` puts it here, which a fresh shell may not have on PATH.
export PATH="$HOME/.local/bin:$PATH"
command -v modal >/dev/null || { echo "Chýba modal: uv tool install modal"; exit 1; }

email="${1:-}"
[[ "$email" == *@* ]] || { echo "Použitie: bash server/setup.sh tvoj@email.sk"; exit 1; }

# `modal profile current` succeeds without a token; listing apps needs a real login.
if ! modal app list >/dev/null 2>&1; then
  echo "== Modal: otvorí sa prehliadač, potvrď prihlásenie =="
  modal token new
fi

echo "== Prístupové kódy appky a kľúče pre notifikácie =="
out="$(node server/mint.mjs "mailto:$email" stanley miska)"
# mint.mjs prints two `modal secret create` lines; run them with --force so a rerun replaces them.
grep '^modal secret create' <<<"$out" | sed 's/^modal secret create /modal secret create --force /' | bash >/dev/null
umask 077
sed -n '/Per person/,$p' <<<"$out" > server/.app-tokens.txt
echo "Uložené. Kódy pre telefóny sú v server/.app-tokens.txt (len na tomto Macu)."

echo
bash server/claude-token.sh
