"""The "Opýtaj sa" chat: one question about one jump, answered through Claude Code (`claude -p`)
on the asking person's own subscription token, the same way the coaching is written.

What it knows: the jump the app sends (numbers against the norms, the "O koľko ďalej" card, the
athlete's earlier jumps) and server/knowledge.md, a digest of the athletes' own notes
(tools/build-knowledge.mjs; gitignored, baked into the Modal image only).
"""
import json
import os
import shutil
import subprocess
import tempfile

MODEL = "claude-opus-5-5"
MAX_MESSAGES = 20
MAX_TEXT = 2000
MAX_CONTEXT = 24000

SYSTEM = """Si tréner v slovenskej appke na rozbor skoku do diaľky pre dvoch atlétov, Stanleyho a Mišku. Atlét sa pýta na jeden konkrétny skok.

Pravidlá odpovede:
- Po slovensky, krátko, ako keď hovoríš na dráhe: najviac 120 slov, bežné odseky, bez nadpisov a odrážok.
- Hovor pozitívne, o zlepšení: čo urobiť a čo to prinesie, nie čo je zlé („prídeš do dosky rýchlejšie“, nie „si pomalý“).
- Keď sa otázka týka chyby, uveď číslo atléta a normu z kontextu skoku ako cieľ, ku ktorému ide.
- Daj JEDEN cue, iba z povolených cue v poznámkach atlétov (Coaching SOP, časť Jazyk), nikdy zakázaný. Cue napíš v úvodzovkách „takto“.
- Povedz, prečo to v tomto skoku pomôže a koľko to stojí v cm, ak je to na karte „O koľko ďalej“.
- Cviky alebo tréningové zmeny daj iba vtedy, keď sa na ne atlét výslovne opýta, a drž sa jeho poznámok.
- Nikdy si nevymýšľaj čísla. Používaj len čísla z kontextu skoku a z poznámok. Keď niečo nevieš alebo to video nezmeralo, povedz to rovno.
- Nespomínaj umelú inteligenciu, modely ani značky. Nepíš, že si program.
- Neobmedzuj atléta odhadmi typu „za sezónu“: cieľ je norma.
- Hovor k atlétovi v druhej osobe. V minulom čase používaj tvary, ktoré sedia pre muža aj ženu, alebo meno z kontextu.
"""


def validate(payload):
    """(context dict, messages list) or raises ValueError with a Slovak message."""
    if not isinstance(payload, dict):
        raise ValueError("Zlá požiadavka.")
    msgs = payload.get("messages")
    if not isinstance(msgs, list) or not msgs or len(msgs) > MAX_MESSAGES:
        raise ValueError("Rozhovor je prázdny alebo príliš dlhý.")
    clean = []
    for m in msgs:
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant") or not isinstance(m.get("text"), str):
            raise ValueError("Zlá správa v rozhovore.")
        clean.append({"role": m["role"], "text": m["text"][:MAX_TEXT]})
    if clean[-1]["role"] != "user" or not clean[-1]["text"].strip():
        raise ValueError("Chýba otázka.")
    ctx = payload.get("jump") or {}
    if len(json.dumps(ctx, ensure_ascii=False)) > MAX_CONTEXT:
        raise ValueError("Kontext skoku je príliš veľký.")
    return ctx, clean


def build_prompt(ctx, msgs):
    lines = ["Kontext skoku (JSON z appky):", json.dumps(ctx, ensure_ascii=False, indent=1), "", "Rozhovor:"]
    for m in msgs:
        lines.append(("Atlét: " if m["role"] == "user" else "Tréner: ") + m["text"])
    lines.append("")
    lines.append("Odpovedz na poslednú otázku atléta.")
    return "\n".join(lines)


def system_prompt(knowledge):
    return SYSTEM + ("\n\nPoznámky atlétov (ich vlastný vault):\n\n" + knowledge if knowledge else "")


def answer(payload, token, knowledge="", bin="claude", timeout=100, run=subprocess.run):
    """{"answer": str}. Raises ValueError (bad request) or RuntimeError (no answer)."""
    ctx, msgs = validate(payload)
    if not token:
        raise RuntimeError("Na serveri nie je nastavený prístup pre tohto atléta.")
    home = tempfile.mkdtemp(prefix="jump-chat-")
    env = {"PATH": os.environ.get("PATH", ""), "HOME": home, "CLAUDE_CONFIG_DIR": home, "LANG": "C.UTF-8",
           "DISABLE_AUTOUPDATER": "1", "CLAUDE_CODE_OAUTH_TOKEN": token}
    args = [bin, "-p", "--safe-mode", "--tools", "", "--no-session-persistence", "--max-turns", "1",
            "--model", MODEL, "--effort", "medium", "--output-format", "json", "--system-prompt", system_prompt(knowledge)]
    try:
        p = run(args, input=build_prompt(ctx, msgs), capture_output=True, text=True, env=env, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RuntimeError("Odpoveď trvala príliš dlho, skús znova.")
    finally:
        shutil.rmtree(home, ignore_errors=True)
    try:
        out = json.loads(p.stdout or "{}")
    except ValueError:
        out = {}
    text = (out.get("result") or "").strip() if isinstance(out, dict) else ""
    if not text:
        hint = (p.stderr or p.stdout or "").replace(token, "[token]")[:200]
        print("chat: no answer:", hint)
        raise RuntimeError("Odpoveď sa nepodarilo získať, skús znova.")
    return {"answer": text}
