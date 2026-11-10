#!/bin/bash
# Stores Claude subscription tokens (from `claude setup-token`) in the Modal Secret jump-claude.
# Run it yourself in a terminal; the tokens never reach a chat or a file.
# Usage: bash server/claude-token.sh
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"

echo "== Claude cez tvoje predplatné =="
echo "Otvorí sa prehliadač, prihlás sa svojím Claude účtom. Na konci sa vypíše token (sk-ant-oat…)."
read -r -p "Enter pre pokračovanie (ak token už máš, napíš s a Enter): " skip
if [[ "$skip" != "s" ]]; then
  # Inside a Claude session the nested CLI can refuse to start; clear its markers.
  env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u ANTHROPIC_API_KEY claude setup-token \
    || echo "(claude setup-token skončil s chybou; ak sa token vypísal, pokračuj)"
fi
echo
# A token copied from a wrapped terminal line arrives as two lines; take whatever the paste held.
read_token() {
  local tok="" line
  echo "$1" >&2
  echo "(nezobrazí sa; po vložení stlač Enter, potom ešte raz Enter na prázdnom riadku)" >&2
  while read -r -s line && [[ -n "${line// /}" ]]; do tok+="$line"; done
  tr -d '[:space:]' <<<"$tok"
}
stanley_tok="$(read_token "Vlož svoj token:")"
if [[ "$stanley_tok" != sk-ant-oat* ]]; then
  echo "Toto nevyzerá ako token zo setup-token (má začínať sk-ant-oat). Nič som neuložil."
  exit 1
fi
miska_tok="$(read_token "Mišin token, ak ho má zo svojho účtu (inak len Enter):")"

json="$(STANLEY="$stanley_tok" MISKA="$miska_tok" node -e '
  const t = { stanley: process.env.STANLEY };
  if (process.env.MISKA) t.miska = process.env.MISKA;
  process.stdout.write(JSON.stringify(t));')"
if modal secret create --force jump-claude JUMP_CLAUDE_TOKENS="$json" >/dev/null; then
  echo "Hotovo, jump-claude uložený. Napíš Claudovi, nech nasadí."
else
  echo "Uloženie do Modalu zlyhalo (chyba je vyššie)."
  exit 1
fi
