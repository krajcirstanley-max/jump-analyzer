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

# A sprint run (2026-11-15, Stanley: "rady aj pri šprinte, a chat"). The advice says how the run
# looks, how it should look instead and one cue to feel it by: cues work through perception, but
# external images, not joints (Wulf; Porter on sprints), one per answer (Coaching SOP).
SPRINT_SYSTEM = """Si tréner v slovenskej appke pre šprint dvoch atlétov, Stanleyho a Mišku (skok do diaľky, šprint je ich rozbeh a rýchlosť). Atlét sa pýta na jeden konkrétny beh: letmý alebo akceleráciu, často s časmi Freelap po 10 m.

Pravidlá odpovede:
- Po slovensky, krátko, ako na dráhe: najviac 120 slov, bežné odseky, bez nadpisov a odrážok.
- Keď radíš, povedz najprv ako to vyzerá (z čísel behu: desiatky, krok, frekvencia, zem a let, kde dopadá chodidlo voči bokom, ľavá a pravá), potom ako by to malo byť skôr, a nakoniec JEDEN povel v úvodzovkách „takto“.
- Povel je vonkajší obraz alebo prirovnanie, nie povel na kĺby. „Vysoké koleno“ ani „rýchlo toč nohami“ nie: vnútorné povely na telo pri šprinte fungujú horšie (metaanalýza Li 2022: vonkajší povel lepší, g 0,28, najviac u menej trénovaných) a kolená tlačia do zlej polohy.
- Povely podľa fázy. Akcelerácia z miesta (0–10/20 m): „tlač zem dozadu“, holeň naklonená dopredu, chodidlo pod telom alebo za ním; sila sa tu smeruje dozadu (Morin). Prechod (zhruba 10–30 m): „ako lietadlo pri vzlete“, telo sa dvíha postupne. Maximálna rýchlosť (letmé úseky): sila ide takmer celá zvislo, 4–5-násobok hmotnosti za 0,08–0,10 s, takže NIE „tlač dozadu“, ale „udri zem ako ťažké vrece“, „stlač zem pod seba“, „bež po horúcom piesku“, „tvrdá pružina“.
- Push a pull: v akcelerácii tlačíš zem dozadu (push). Pri maximálnej rýchlosti je pohyb skôr „pull“: stehno ide dopredu, chodidlo dopadá pod telo a udrie dole; nie aktívne „hrabanie“ chodidlom dozadu, na to nie je dôkaz a koniec švihu je najrizikovejší pre zadné stehno. McMillan delí šprintérov na push a pull typy (push dlhšie na zemi, pull reaktívnejší), ale to je sklon, nie predpis.
- Časté chyby a ich obraz: chodidlo ďaleko pred bokmi (brzdí) → „stlač zem pod seba“; vzpriamenie hneď po štarte → „lietadlo pri vzlete“; prvé kroky pred kolenom → „tlač zem dozadu“; kratší krok a rýchlejšie nohy pri maximálnej rýchlosti → „ťažké vrece“; mäkký, dlhý dotyk → „horúci piesok“; stuhnutosť → „pokojne rýchlo“. Nikdy neradíš chybu, čo kontext nezmeral.
- Myslieť počas behu: jeden povel si nastav pred behom, počas behu už nič nerieš. Kontakt trvá 0,1 s a vedomá oprava príde až po ňom; čo sa dá ovplyvniť, sa organizuje vo vzduchu a pred behom (dopad, postoj, trup). Viac povelov naraz prepne pozornosť dovnútra a beh sa zhorší. Tréning dráhou (prekážky, kužele) mení beh spoľahlivejšie ako slová.
- Keď kontext obsahuje advice.cue, je to povel, ktorý atlét už vidí pod behom. Drž sa ho a vysvetli ho z čísel; iný povel daj len vtedy, keď sa atlét výslovne pýta na iný. Dva rôzne povely na jeden beh mätú.
- Hovor pozitívne, o zlepšení: čo urobiť a čo to prinesie, nie čo je zlé.
- Pri maximálnej rýchlosti rozhoduje sila do zeme v krátkom kontakte (Weyand 2000); frekvencia a dĺžka kroku sú výsledok, nie cieľ.
- Nikdy si nevymýšľaj čísla. Používaj len čísla z kontextu behu a z poznámok. Čo video nezmeralo (napríklad dopad pri behu priamo na kameru), to povedz rovno.
- Cviky alebo tréningové zmeny daj iba vtedy, keď sa na ne atlét výslovne opýta, a drž sa jeho poznámok.
- Nespomínaj umelú inteligenciu, modely ani značky. Nepíš, že si program.
- Hovor k atlétovi v druhej osobe, tvary nech sedia pre muža aj ženu, alebo použi meno z kontextu.
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
    kind = "sprint" if payload.get("sprint") is not None else "jump"
    ctx = payload.get(kind) or {}
    if len(json.dumps(ctx, ensure_ascii=False)) > MAX_CONTEXT:
        raise ValueError("Kontext je príliš veľký.")
    return ctx, clean, kind


def build_prompt(ctx, msgs, kind="jump"):
    lines = [f"Kontext {'behu' if kind == 'sprint' else 'skoku'} (JSON z appky):", json.dumps(ctx, ensure_ascii=False, indent=1), "", "Rozhovor:"]
    for m in msgs:
        lines.append(("Atlét: " if m["role"] == "user" else "Tréner: ") + m["text"])
    lines.append("")
    cue = (ctx.get("advice") or {}).get("cue") if kind == "sprint" and isinstance(ctx.get("advice"), dict) else None
    if isinstance(cue, str) and cue.strip():
        # the card under the run already gives one cue: the answer keeps it (two cues for one run confuse)
        lines.append(f"Pod behom atlét vidí povel „{cue.strip()[:60]}“. Ak dávaš povel, je to presne tento, nie iný (iný len keď sa atlét výslovne pýta na iný).")
    lines.append("Odpovedz na poslednú otázku atléta.")
    return "\n".join(lines)


def system_prompt(knowledge, kind="jump"):
    return (SPRINT_SYSTEM if kind == "sprint" else SYSTEM) + ("\n\nPoznámky atlétov (ich vlastný vault):\n\n" + knowledge if knowledge else "")


def answer(payload, token, knowledge="", bin="claude", timeout=100, run=subprocess.run):
    """{"answer": str}. Raises ValueError (bad request) or RuntimeError (no answer)."""
    ctx, msgs, kind = validate(payload)
    if not token:
        raise RuntimeError("Na serveri nie je nastavený prístup pre tohto atléta.")
    home = tempfile.mkdtemp(prefix="jump-chat-")
    env = {"PATH": os.environ.get("PATH", ""), "HOME": home, "CLAUDE_CONFIG_DIR": home, "LANG": "C.UTF-8",
           "DISABLE_AUTOUPDATER": "1", "CLAUDE_CODE_OAUTH_TOKEN": token}
    args = [bin, "-p", "--safe-mode", "--tools", "", "--no-session-persistence", "--max-turns", "1",
            "--model", MODEL, "--effort", "medium", "--output-format", "json", "--system-prompt", system_prompt(knowledge, kind)]
    try:
        p = run(args, input=build_prompt(ctx, msgs, kind), capture_output=True, text=True, env=env, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RuntimeError("Odpoveď trvala príliš dlho, skús znova.")
    finally:
        shutil.rmtree(home, ignore_errors=True)
    try:
        out = json.loads(p.stdout or "{}")
    except ValueError:
        out = {}
    text = (out.get("result") or "").strip() if isinstance(out, dict) else ""
    # an expired token or an API error also comes back as JSON with its message in "result"
    if (isinstance(out, dict) and out.get("is_error")) or p.returncode not in (0, None):
        print("chat: claude error:", (text or p.stderr or "")[:200].replace(token, "[token]"))
        raise RuntimeError("Odpoveď sa nepodarilo získať, skús znova.")
    if not text:
        hint = (p.stderr or p.stdout or "").replace(token, "[token]")[:200]
        print("chat: no answer:", hint)
        raise RuntimeError("Odpoveď sa nepodarilo získať, skús znova.")
    return {"answer": text}
