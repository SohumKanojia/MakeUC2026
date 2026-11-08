# Agent Handoff — Braille Glove

Written for whoever (human or agent) picks this up next. It assumes you have not
seen the project before. Read this top to bottom before touching code; it is
ordered by what will cost you time if you skip it.

- **Full reference:** [DOCS.md](DOCS.md)
- **Working rules for this repo:** [CLAUDE.md](CLAUDE.md)
- **Orientation:** [README.md](README.md)

---

## 1. What this is, in four sentences

A haptic braille glove for deafblind users, built at MakeUC 2026. A Chrome
extension turns whatever is under the mouse — or a whole page — into braille
cells; a Python bridge relays them over USB serial; an ESP32 pulses six motors on
the palm. Fingertip force sensors type characters back.

```
Chrome extension (MV3) <-- ws://127.0.0.1:8787 --> bridge/bridge.py <-- USB serial 115200 --> ESP32
```

---

## 2. Current state

| Component | State | Confidence |
|---|---|---|
| `extension/braille.js` converter | complete | high — 36 tests |
| `extension/content.js` hover + capture | complete | medium-high — exercised in-browser via the built-in browser, not a real Chrome profile |
| `extension/background.js` playback, discovery | complete | medium-high |
| `extension/popup.*` | complete | medium |
| `bridge/bridge.py` | complete | high — 26 protocol tests |
| `bridge/gemini.py` | complete | medium-high — 34 tests against a stub; **one live path unconfirmed** |
| `firmware/braille_glove.ino` | written | **low — never run on hardware** |
| Firmware host tests | complete | high — 64 tests, logic only |

**160 tests pass. No hardware, API key or network needed to run them.**

---

## 3. Read these before changing anything

Five facts that are not obvious from the code and that cost real time to
rediscover.

### 3.1 `thinkingConfig: {thinkingBudget: 0}` is load-bearing

In `bridge/gemini.py`. Without it, Flash models burn their thinking budget and
calls take **over 40 seconds** instead of ~1 second. Every "summarization is
broken" report traced back to this. Do not remove it as "unnecessary config".

### 3.2 The two timeouts are deliberately mismatched

Bridge timeout **5 s**, extension wait **6.5 s**. The extension waits longer *on
purpose* so the bridge has time to deliver its own fallback (the head of the page
text). Shorten the extension's wait below the bridge's timeout and the user gets
nothing instead of degraded-but-useful text.

### 3.3 `braille.js` must stay a plain script

It is an IIFE attaching `Braille` to `self`, which is what lets one file load in
four hosts: content script, service worker (`importScripts`), `converter.html`
(`<script src>`), and Node (`test-braille.js` sets `global.self = {}` then
`require`s it). Adding `import`/`export` or any bundler syntax breaks at least
one — and three of them fail *silently*.

### 3.4 The letter table is duplicated

`extension/braille.js` and `bridge/bridge.py` (`LETTER_DOTS`) each hold their own
copy. The bridge needs one to decode `IN: <n>` and to draw `--mock` cells.
**Change one and you must change the other.** `bridge/test_protocol.py` catches
drift — if you run it.

### 3.5 Protocol changes touch three places plus two test files

1. the firmware's command parser
2. `bridge/bridge.py`
3. **both** `bridge/test_protocol.py` and `firmware/test/test_firmware.cpp`

The two halves of the protocol were written against the spec, not against each
other. These paired tests are the only thing holding them in sync. Update them
together.

---

## 4. How to get running in five minutes

```bash
pip install -r bridge/requirements.txt
```

```bash
python bridge/bridge.py --mock
```

```bash
python -m http.server 8123
```

Load the extension: `chrome://extensions` → Developer mode → Load unpacked →
`extension/`. Open <http://localhost:8123/demo.html> and hover something.

With a key (set inline so it never lands in a file):

```bash
GEMINI_API_KEY=your-key python bridge/bridge.py --mock
```

Tests:

```bash
./run-tests.sh
```

**`run-tests.sh` masks exit codes** — it pipes each suite through `tail -2`. Read
the `N passed, M failed` lines, or run a suite directly.

---

## 5. Open work, in priority order

### P1 — Push the initial commit (blocked, needs the user)

The repo is initialized locally with `origin` pointing at
`https://github.com/SohumKanojia/MakeUC2026` (a friend's public repo, verified
empty: created 2026-11-08, zero commits, default branch `main`). The commit is
ready. **The push was blocked by the sandbox** as a public-surface write, which
is a correct call — the user must run it:

```bash
git push -u origin main
```

If it returns 403, the user is not a collaborator yet; Sohum adds them under
Settings → Collaborators. To land it on a branch for review instead:
`git push -u origin main:braille-glove`.

### P2 — Bench bring-up of the glove

The firmware has never run on an ESP32. In order:

1. Flash it (Arduino IDE, board **ESP32 Dev Module**, library **Adafruit
   DRV2605**, 115200 baud).
2. Send `SCAN`. Expect `EVT DRIVERS 0x3F` — all six drivers answering. Anything
   less is wiring or the mux.
3. Send `TEST`. Each motor fires in turn. **Feel the order and fix
   `DOT_TO_CHANNEL`** at the top of the `.ino`. The spec marks this table
   "confirm physically"; it is almost certainly wrong as shipped. If letters come
   out scrambled, this is the cause — not the converter.
4. Tune `AMPLITUDE` (currently 110, range 0–127) and set `MOTOR_IS_LRA`
   correctly (`false` = ERM coin motors).
5. Calibrate `PRESS_DELTA` / `RELEASE_DELTA` (350 / 200) by watching raw ADC
   values with the glove actually worn — FSR resting values change every time it
   is put on.
6. **Power the motors from a separate supply with a common ground.** Six motors
   on the ESP32's regulator will brown it out.

### P3 — Confirm live whole-page summarization

The code path is tested against a stub; the real round trip was never confirmed
because the attempt hit a 429 (per-*minute* limit). Fastest check, no browser
needed:

```bash
GEMINI_API_KEY=your-key python bridge/bridge.py --summarize article.html
```

Then do it again through the extension's **Read whole page** button and confirm
the popup shows `Gemini ready (<model>)` rather than one of the two degraded
states.

### P4 — Load the extension in a real Chrome profile

It has been driven in the built-in browser but never installed in the user's own
Chrome end to end. Loading unpacked needs an OS file dialog, so this is a
human step.

### P5 — Nice to have

- A single-test runner, and fix `run-tests.sh`'s exit code.
- De-duplicate the letter table (probably by generating the Python one).

---

## 6. Environment and tooling notes

- **Working directory:** `C:\Users\adity\Desktop\makeuc` (Windows 11).
- **No build step, bundler, linter or package manager.** Deliberate: zero
  install friction at a 24-hour hackathon. Do not add one casually.
- Run shell scripts from **Git Bash**. PowerShell is the primary shell but the
  scripts are POSIX.
- **Use the Write/Edit tools, not bash heredocs, for any file containing
  escapes.** `cat > f <<'EOF'` with JS or Python content repeatedly mangled this
  repo: `\n` and `\t` became literal newlines and tabs, and `\` line
  continuations were eaten — producing syntax errors and silently no-op
  `str.replace()` calls. This wasted significant time; do not repeat it.
- **Leftover processes.** A long session left http servers on 8123/8124 and
  bridges on 8787 (stale), 8788 (stale), 8789, 8790, 8791, 8792 scattered across
  the probe range. The sandbox blocked `taskkill`/`Stop-Process`, so they may
  still be running. If the extension connects to a bridge that cannot summarize,
  this is why — the popup will say *"too old to summarize"*.
- `spec`: comments throughout cite section numbers of `context.md`
  (e.g. "context.md 9.3"). **That file is not in the repo.** The README, DOCS.md
  and the code comments are the only surviving record of it. Do not treat a
  missing `context.md` as a broken reference.

---

## 7. Constraints that must not be relaxed

These came from the spec and from the user's explicit decisions. Treat them as
requirements, not preferences.

1. **The Gemini API key never goes in extension code.** Spec §8.3: *"Never put
   the key in extension code. Use a tiny local proxy (localhost) that holds
   it."* It lives only in the bridge's environment. Extension source is readable
   by anyone who installs it. A pre-commit scan confirmed the key appears in no
   tracked file — keep it that way.
2. **Passwords are never read out.** `controlValue()` in `content.js` returns
   `''` for `type === 'password'`, unconditionally. A braille glove is used in
   public.
3. **The bridge binds `127.0.0.1`.** It accepts unauthenticated commands; on a
   LAN anyone could drive the glove and spend the API key.
4. **Gemini prompt rule 2 (NO ADDED QUALIFIERS) is a safety rule, not style.**
   The reader cannot see the page to check. A model that turns *"step free along
   its entire length"* into *"fully accessible"* has told a disabled user
   something false about somewhere they may be about to travel. Everything the
   glove says must be something the page actually said. Read DOCS.md §6.3 before
   editing the prompt.
5. **Nothing in the firmware's `loop()` may block.** No `delay()` outside
   `setup()`. A 400 ms blocking pulse swallows any fingertip press during it, so
   input appears to drop at random.
6. **WiFi stays off in the firmware.** The thumb FSR is on GPIO 25 = ADC2, which
   dies when WiFi is enabled. If the thumb misreads, move it to GPIO 36 or 39 —
   do not re-enable WiFi.
7. **Mode 1 and mode 2 stay separated.** The `enabled` setting governs hover
   only and must not gate page reading; a page read suspends hover; pointer
   movement must not cancel a read. All three were bugs once. See the three
   guards in `background.js`.
8. **A rotated key.** The user's live key appeared in a chat transcript. It
   should be rotated after the hackathon.

---

## 8. Where to look for what

| You want to change | Go to |
|---|---|
| Letter/dot mapping, flags, dropped chars | `extension/braille.js` **and** `LETTER_DOTS` in `bridge/bridge.py` |
| What a hovered element says | `describe()`, `controlName()`, `controlValue()` in `extension/content.js` |
| What a page read captures | `captureScreen()` and `ARIA_FIRST` in `extension/content.js` |
| Pacing, interrupts, mode separation | `extension/background.js` |
| Which bridge the extension picks | `judgeBridge()`, `nextCandidate()`, `PROBE_FIRST`/`PROBE_LAST` in `background.js` |
| Serial framing | `bridge/bridge.py` |
| The summarization prompt | `_RULES` in `bridge/gemini.py` |
| Motor driving, I2C, chord input | `firmware/braille_glove/braille_glove.ino` |
| Bench constants | top of the `.ino` |
| Arduino fakes for tests | `firmware/test/shim/` |

---

## 9. First thing to do

Run the tests. They need nothing installed beyond `pip install -r
bridge/requirements.txt`, `node`, `python` and `g++`, and a green 160 tells you
the checkout is intact before you change anything.

```bash
./run-tests.sh
```

Then read DOCS.md §2 (cell encoding) — every component shares that one byte
format, and nothing else in the system makes sense until it does.
