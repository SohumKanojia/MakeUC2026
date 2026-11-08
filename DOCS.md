# Braille Glove — Full Documentation

A haptic braille reader and writer for deafblind users, built at MakeUC 2026.

Point the mouse at anything in a web page; a moment later six motors on your palm
spell it out in braille, one cell at a time. Press the fingertip sensors and the
glove types characters back. A button in the extension reads a whole page,
optionally summarized by Gemini first.

This document covers every component, how they fit together, how to run and test
each one, and the decisions that are easy to get wrong. For a shorter
orientation read [README.md](README.md); for picking up unfinished work read
[AGENT_HANDOFF.md](AGENT_HANDOFF.md).

---

## Table of contents

1. [System overview](#1-system-overview)
2. [Cell encoding — the one format everything shares](#2-cell-encoding--the-one-format-everything-shares)
3. [Quick start](#3-quick-start)
4. [The Chrome extension](#4-the-chrome-extension)
5. [The Python bridge](#5-the-python-bridge)
6. [Gemini summarization](#6-gemini-summarization)
7. [The ESP32 firmware](#7-the-esp32-firmware)
8. [The serial protocol](#8-the-serial-protocol)
9. [Testing](#9-testing)
10. [Test pages and the standalone converter](#10-test-pages-and-the-standalone-converter)
11. [Configuration reference](#11-configuration-reference)
12. [Troubleshooting](#12-troubleshooting)
13. [Security and privacy](#13-security-and-privacy)
14. [Known gaps](#14-known-gaps)

---

## 1. System overview

```
┌──────────────────────┐   ws://127.0.0.1:8787   ┌──────────────┐   USB serial   ┌─────────┐
│ Chrome extension     │ ──────────────────────> │ bridge.py    │ ─────────────> │ ESP32   │
│ (MV3)                │ <────────────────────── │              │ <───────────── │         │
│ hover + page reading │     JSON commands       │ JSON <-> ASCII│   115200 baud  │ 6 motors│
│ text -> braille      │     and events          │ + Gemini      │                │ 5 FSRs  │
└──────────────────────┘                         └──────────────┘                └─────────┘
```

**The governing design rule: the host does the thinking, the ESP32 only pulses
cells when told to.** Text-to-braille conversion, per-cell pacing and interrupt
handling all live in the extension's service worker. The firmware receives
`CELL n` / `DUR ms` / `CLEAR` and nothing smarter.

There is exactly one exception, and it is deliberate: **chord input runs entirely
in firmware.** When a finger presses, the palm must confirm that stroke
instantly. A USB round trip to the host and back is too slow to feel like direct
manipulation, so the firmware owns stroke detection, the two-stroke state
machine, tap classification and the confirmation pulses. It reports only
finished characters upward.

### Why a WebSocket bridge instead of Web Serial

Three reasons, in order of weight:

1. **The API key must never ship in extension code.** Extension source is
   readable by anyone who installs it. The bridge is a local process, so the key
   lives in its environment and never crosses to the browser.
2. **Web Serial needs a user gesture per port and does not survive a service
   worker restart.** MV3 service workers are killed aggressively; a WebSocket
   reconnects without asking the user anything.
3. **The bridge can do work the browser cannot** — call Gemini without CORS
   problems, drive the keyboard with `--type-keys`, and render cells in a
   terminal with `--mock` so the whole pipeline is demoable with no hardware.

### What runs where

| Concern | Lives in | Why there |
|---|---|---|
| Text → braille cells | `extension/braille.js` | One converter, four hosts |
| Per-cell pacing, interrupts | `extension/background.js` | Needs to cancel on a new hover target |
| Label extraction, DOM capture | `extension/content.js` | Needs the page's DOM |
| Serial framing | `bridge/bridge.py` | Owns the port |
| Gemini + the API key | `bridge/gemini.py` | Key must stay off the browser |
| Motor driving | firmware | Owns I2C |
| Chord input | firmware | Latency |

---

## 2. Cell encoding — the one format everything shares

A braille cell is **one byte**. Six dots, laid out in two columns of three:

```
   dot1  dot4        bit0  bit3
   dot2  dot5        bit1  bit4
   dot3  dot6        bit2  bit5
```

So `bit0 = dot 1 … bit5 = dot 6`, and bits 6–7 are unused. Two consequences
used throughout the codebase:

- **The Unicode braille character is `U+2800 + byte`.** `String.fromCharCode(0x2800 + n)`
  renders any cell for a sighted demo, with no font tricks or image assets.
- **Byte 0 is a space** — a blank cell, and the host pauses longer for it
  (`spaceMs`) so the gap reads as a word break rather than a dropped cell.

Two worked examples that appear in the tests on every side of the system:

| Letter | Dots | Bits set | Byte |
|---|---|---|---|
| `d` | 1, 4, 5 | 0, 3, 4 | `0b011001` = **25** |
| `y` | 1, 3, 4, 5, 6 | 0, 2, 3, 4, 5 | `0b111101` = **61** |

If you change anything about encoding, these two numbers are the canary — they
are asserted in `test-braille.js`, `bridge/test_protocol.py` and
`firmware/test/test_firmware.cpp`.

### Character coverage

Default output is **lowercase a–z plus spaces only**. Capitals, digits and
punctuation exist in the converter behind opt-in flags, and the extension leaves
them off. The reason is comprehension, not laziness: an untrained finger reading
at 400 ms per cell gets overwhelmed by prefix indicators. A number in Grade 1
braille costs a number-sign cell plus a digit cell per digit, which can double
the length of a sentence for information the reader usually does not need.

The Gemini prompt enforces the same restriction from the other end (rule 4), and
`to_glove_text()` enforces it again on the output regardless of what the model
returned. Three layers, because a model that disobeys the format is a routine
occurrence, not an exceptional one.

### Duplicated table warning

`bridge/bridge.py` keeps its **own copy** of the letter table as `LETTER_DOTS`.
It needs one to decode `IN: <n>` from the glove and to draw cells in `--mock`,
and importing JavaScript into Python is not worth a build step for 26 entries.
**Change one and you must change the other.** `bridge/test_protocol.py` asserts
the two agree on `d`, `y` and a full a–z round trip, so the test suite will catch
a drift — but only if you run it.

---

## 3. Quick start

There is no build step, no bundler, no linter and no package manager. On Windows
run the shell scripts from Git Bash.

### Everything, with no hardware

```bash
pip install -r bridge/requirements.txt
```

```bash
python bridge/bridge.py --mock
```

`--mock` draws each cell in the terminal as Unicode braille instead of sending
it to a port, so you can watch the whole pipeline work before the glove exists.

Then serve the test pages (content scripts do not run on `file://`):

```bash
python -m http.server 8123
```

Load the extension: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select the `extension/` folder. Open <http://localhost:8123/demo.html>
and hover anything.

### With the glove

```bash
python bridge/bridge.py
```

The serial port is auto-detected. `--list` shows candidates, `--port COM5`
forces one.

### With summarization

The bridge reads `GEMINI_API_KEY` from its own environment. Set it inline so it
never lands in a file:

```bash
GEMINI_API_KEY=your-key python bridge/bridge.py --mock
```

`GEMINI_MODEL` overrides the model. Without a key everything still works and
falls back to the raw page text.

### Run the tests

```bash
./run-tests.sh
```

---

## 4. The Chrome extension

Manifest V3. Permissions are `storage`, `scripting`, `activeTab` — no host
permissions, because the content script is declared in the manifest against
`<all_urls>` rather than injected.

```
extension/
  manifest.json
  braille.js      the converter, shared by every host
  content.js      hover reader + DOM capture + on-page overlay
  background.js   service worker: WebSocket, playback engine, discovery
  popup.html/js   UI: status, modes, sliders, byte history
```

### 4.1 `braille.js` — the single converter

An IIFE that attaches `Braille` to `self`. That one detail is what lets the same
file load in **four** places without modification:

| Host | How it loads |
|---|---|
| Content script | listed in `manifest.json` `content_scripts.js` |
| Service worker | `importScripts('braille.js')` |
| `converter.html` | plain `<script src>` |
| Node (tests) | `test-braille.js` sets `global.self = {}` then `require`s it |

**Keep it a plain script.** No ES modules, no `import`/`export`, no bundler
syntax — any of those breaks at least one of those four hosts, and three of them
fail silently rather than loudly.

API:

```js
Braille.textToCells(text, opts)    // [{ch, n, dots, kind, label, unicode}, ...]
Braille.textToBytes(text, opts)    // [19, 10]
Braille.textToUnicode(text, opts)  // '⠓⠊'
Braille.byteToChar(n)              // inverse, used for glove input
Braille.estimateMs(cells, timing)  // how long a playback will take
Braille.droppedChars(text, opts)   // what the current flags cannot render
```

`opts` defaults to `BASIC = {capitals: false, numbers: false, punctuation: false}`.
`CAPITAL_BYTE` is 32 (dot 6) and `NUMBER_BYTE` is 60 (dots 3,4,5,6); the
punctuation table follows UEB.

`droppedChars()` exists so the UI can be honest. Silently discarding a quarter
of a sentence is the kind of bug that looks like a hardware fault, so the
converter can report exactly which characters it refused.

### 4.2 `content.js` — the hover reader

**Hover flow.** `mouseover` starts a dwell timer (`dwellMs`, default 250 ms).
Without the dwell, crossing a dense page fires dozens of playbacks and each
cancels the previous one, so the palm feels nothing but static. On expiry the
element is described and the text is sent to the service worker.

**`describe(el)` builds the label in a specific order**, and the ordering is the
whole point:

```js
[type, label, state].filter(Boolean).join(' ')
// -> "button save", "field email empty", "menu city dayton"
```

The label is resolved by accessibility precedence — `aria-label` →
`aria-labelledby` → `alt` → input label/value/placeholder → `innerText` →
`title` — then **truncated to `maxChars`**, and only **then** is the type word
prefixed. That order matters: prefixing before truncation means a long label can
cut the type word off entirely, and "savings account transf" tells a blind user
much less than "field savings account". Knowing *what kind of thing* is under
the cursor is more valuable than the last few characters of its name.

**`controlName(el)`** clones the `<label>` element and strips nested
`input, select, textarea, button` before reading its text. Without that,
`<label>City <select><option>cincinnati</option>…</select></label>` reads as
"City cincinnati dayton columbus" — the label plus every option.

**`controlValue(el, tag)` returns `''` for `type === 'password'`.** Passwords are
never read out, under any setting. A braille glove is used in public.

**Page capture — `captureScreen(scope)`** has three scopes:

| Scope | What it covers |
|---|---|
| `full` | the whole document |
| `visible` | only what is inside the viewport, via `getBoundingClientRect` |
| `article` | a Readability-style content scorer: main prose, no nav/ads/footer |

`full` and `visible` **walk text nodes** rather than reading `innerText`.
`innerText` on a container returns the concatenated text of its descendants, so
a naive walk that also recurses duplicates everything once per nesting level. It
skips `SKIP_TAGS` (script, style, nav chrome), honours `isRendered` and
`onScreen`, handles `img` alt text, inputs, textareas and selects, and follows
**open** shadow DOM (closed roots are inaccessible by design).

Two bugs worth knowing about, because the fixes look arbitrary otherwise:

```js
const ARIA_FIRST = new Set(['button','a','summary','label','option','th']);

const aria = node.getAttribute('aria-label');
if (aria && (ARIA_FIRST.has(tag) || !node.firstElementChild)) { push(aria); return; }
if (!node.firstElementChild && !node.textContent.trim()) { push(node.getAttribute('title')); return; }
```

- `ARIA_FIRST` exists because an `aria-label` should *replace* content on
  controls and leaves, but not on a `<div aria-label="main">` wrapping the whole
  article — returning early there would discard the page.
- The `!node.firstElementChild` guard on the icon-only shortcut fixes a case
  where **all `alt` text vanished**: a container holding only an `<img>` has
  empty `textContent`, so the shortcut fired and returned before descending into
  the image.

**Overlay.** The on-page cell overlay lives here too: a mirror of the palm,
drawn as Unicode braille, so a sighted person can follow a demo without wearing
the glove.

### 4.3 `background.js` — the service worker

**Playback engine.** Each playback gets a **token**. A new hover target
increments the token, cancels the current playback and sends `CLEAR`. Without a
token, the old playback's pending `setTimeout` callbacks keep firing after the
new one starts and the two interleave into gibberish — the token makes every
stale callback a no-op.

Pacing comes from `cellMs` (vibration per cell), `gapMs` (silence between),
`spaceMs` (extra for a blank cell) and `readCellMs` (used for page reads, which
default slower because the reader has no visual context to anchor to).

**Two modes, kept strictly apart.** This is enforced by three guards:

```js
if (!cfg.enabled && msg.source !== 'extract') break;   // hover toggle governs mode 1 only
if (readingPage && msg.source !== 'extract') break;    // a page read suspends hover
case 'cancel': if (readingPage) break;                 // pointer movement must not kill a read
```

The first guard fixes a real bug: the hover toggle was acting as a master switch
and silently disabled page reading. The second and third fix another: *any*
pointer movement used to cancel a page read, which made mode 2 unusable since
nobody holds a mouse perfectly still for ninety seconds. `setReading(on)`
broadcasts `{type: 'reading', on}` so the popup and overlay can show the state.

**Bridge discovery.** When the configured URL is not connected, the worker
probes ports **8787–8796** in a 120 ms sweep (`PROBE_FIRST`, `PROBE_LAST`,
`buildCandidates()`, `nextCandidate()`). This matters because the bridge moves to
the next free port when its own is busy, and stale bridges from earlier runs
accumulate during a long hacking session.

Candidates are judged by the `hello` handshake:

```js
const current = ('gemini' in msg);   // judgeBridge()
```

A bridge that reports a `gemini` field is running current code; one without it
predates `SUMMARIZE` and cannot summarize. `judgeBridge` keeps a current bridge
over an outdated one and remembers `outdatedUrl` as a fallback, so you connect to
the *useful* bridge rather than the lowest-numbered one. This is what produced
the confusing "No API key on the bridge" message — the extension was talking to
a stale 8787 bridge that had never heard of summarization.

**Byte recording.** `recordBytes(text, cells, source)` keeps a 40-entry history
with `sent: wsState === 'connected'`. Bytes are recorded **even with no bridge
at all**, which is what makes the extension fully usable while the glove is
still being built: you see exactly what would have been sent.

**`speakPage(text, title, scope)`** calls `requestSummary(text, title, 6500)`.
That 6500 ms is not arbitrary — see [§6](#6-gemini-summarization).

### 4.4 `popup.js` — the UI

Sections, in order:

- **Mode 1 — mouse hover.** Enable toggle, dwell and truncation.
- **Mode 2 — read the page.** A primary **Read whole page** button, **Stop**, and
  live progress: `cell 312 of 1535 · 20%`.
- **Page capture — DOM, for testing.** Dumps what each scope extracts.
- **Byte output.** The recorded history, as bytes and Unicode.
- **Test a word.** Convert anything by hand.
- **Bridge.** Connection state and reconnect.

The bridge status deliberately distinguishes **three** states, because they need
three different actions from the user:

| Message | Meaning | Fix |
|---|---|---|
| `Gemini ready (gemini-3.6-flash)` | all good | — |
| `Bridge has no GEMINI_API_KEY — reading the raw text.` | current bridge, no key | set the key, restart the bridge |
| `This bridge is too old to summarize — restart it from the current folder.` | stale process | kill it, restart |

### 4.5 Messaging and settings

Messages are `{type: ...}` objects over `chrome.runtime.sendMessage` and
`chrome.tabs.sendMessage`. The authoritative list is the `switch` statements in
`background.js` (`speak`, `cancel`, `getStatus`, `testSpeak`, `stop`,
`capturePage`, `getBytes`, `clearBytes`, `reconnect`, `pattern`,
`extractActiveTab`, plus the inbound `extract`, `mode`, `char`, `serial`,
`summary`, `hello`) and in `content.js` (`cell`, `idle`, `logBytes`, `extract`,
`getPageText`, `config`).

Settings live in `chrome.storage.local`. **Each file keeps its own `DEFAULTS`
object** — a deliberate tradeoff that avoids a shared module (which would break
`braille.js`'s four-host trick) at the cost of one rule: **add a new setting to
every file that reads it**, or that file silently uses a different default and
the bug appears as inconsistent behaviour between popup and page.

---

## 5. The Python bridge

`bridge/bridge.py` — about 480 lines, two dependencies (`websockets`,
`pyserial`).

### 5.1 What it does

JSON commands in, ASCII serial lines out:

```
{"cmd":"CELL","n":25}  ->  CELL 25
{"cmd":"CLEAR"}        ->  CLEAR
{"cmd":"DUR","ms":400} ->  DUR 400
```

Serial lines in, JSON events out:

```
IN: 61            ->  {"type":"char","ch":"y","n":61}
IN: BS            ->  {"type":"backspace"}
EVT THUMB_TAP     ->  {"type":"extract"}
EVT MODE READ     ->  {"type":"mode","mode":"READ"}
```

Anything it does not recognise is forwarded as `{"type":"serial","line":...}`
rather than dropped, so firmware boot messages and errors reach the popup log.

Cell bytes are masked to six bits (`n & 0x3F`) before being written, so a host
bug cannot send the firmware a value it will reject.

An unmapped cell gets a reply in the other direction: `IN: 63` (all six dots,
not a letter in basic mode) produces `{"type":"unknown","n":63}` **and** writes
`PATTERN ERROR` back to the glove, so a mistyped chord buzzes the palm instead of
disappearing.

### 5.2 Port handling

If the WebSocket port is busy the bridge moves to the next free one and says so:

```python
for port in range(args.port_ws, args.port_ws + 10):
    try:
        server = await websockets.serve(bridge.serve, args.host, port)
    except OSError:
        print("[bridge] port %d is busy, trying %d" % (port, port + 1))
        continue
```

That ten-port window is exactly the range the extension probes.

### 5.3 The `hello` handshake

On connect the bridge sends `{mock, gemini, model}`. The `gemini` key is what
lets the extension tell a current bridge from a stale one, so **never remove the
field** — send `false` if there is no key.

### 5.4 Concurrency

`SUMMARIZE` is dispatched via `asyncio.create_task`, not awaited inline. A
summary can take seconds; awaiting it would stall `CELL` and `CLEAR`, so an
interrupt would arrive after the motors had already finished. Blocking HTTP runs
under `asyncio.to_thread`.

### 5.5 CLI

| Flag | Default | Purpose |
|---|---|---|
| `--port` | auto | serial port, e.g. `COM5`, `/dev/ttyUSB0` |
| `--baud` | 115200 | must match the firmware |
| `--host` | 127.0.0.1 | **leave it local** |
| `--port-ws` | 8787 | first WebSocket port to try |
| `--mock` | off | no hardware; draw cells in the terminal |
| `--type-keys` | off | glove input becomes real keystrokes |
| `--list` | — | list serial ports and exit |
| `--model` | env / `gemini-3.6-flash` | override the model |
| `--gemini-timeout` | 5.0 | seconds before falling back |
| `--list-models` | — | what the key can actually call |
| `--summarize FILE` | — | try the prompt on a text file, print and exit |

`--summarize FILE` is the fastest way to iterate on the prompt: no browser, no
extension reload, one API call.

---

## 6. Gemini summarization

`bridge/gemini.py`. Endpoint `POST /v1beta/models/{model}:generateContent`, key
in the `x-goog-api-key` header, answer at
`candidates[0].content.parts[0].text`.

### 6.1 The one line that matters most

```python
"thinkingConfig": {"thinkingBudget": 0}
```

Without it, Flash models spend their thinking budget and calls take **over 40
seconds** — far past any timeout, so summarization appeared completely broken.
With it, warm calls land around **1 second**. If summaries suddenly stop
arriving, check this line first.

The default model is `gemini-3.6-flash` (overridable with `GEMINI_MODEL` or
`--model`). `gemini-flash-latest` never answered within 40 s on the test key,
which is why the default is pinned to an explicit version rather than an alias.

### 6.2 The timeout relationship — do not break it

- bridge timeout: **5 s**
- extension wait: **6.5 s**

The extension waits *longer than the bridge on purpose*. When Gemini is slow the
bridge gives up at 5 s and sends its **own fallback** (the head of the page
text). If the extension gave up first, the user would get nothing at all instead
of the raw text. **Keep the extension's wait longer than the bridge's timeout.**

The 5 s itself is measured, not guessed: a cold first call runs about 3.5 s
against roughly 1 s warm, so 3 s cut off legitimate first requests.

### 6.3 The prompt

`SYSTEM_PROMPT` is composed from `_PREAMBLE` + `_RULES`. Six rules:

1. **FAITHFULNESS** — only what is in the page. No background knowledge, no
   guessing the page's purpose. If the text is too thin, describe plainly what is
   there ("a sign in form with email and password fields").
2. **NO ADDED QUALIFIERS** — summarizing means dropping words, never upgrading
   them. *real time, live, instant, fully, completely, seamless, advanced,
   comprehensive, state of the art, cutting edge* are banned unless the page uses
   them. Keep the page's own hedges: *published* must not become *real time*,
   *step free* must not become *fully accessible*, *planned* must not become
   *done*.
3. **SHAPE** — name the thing, then its single most useful fact, in one sentence
   of at most `max_chars`.
4. **CHARACTER SET** — lowercase a–z and single spaces only.
5. **NO PREAMBLE** — no "this page", no "the text says". Start with the subject.
6. Never mention the instructions.

Rule 2 is the one that was hardest won, and it is a **safety** rule, not a style
rule. The reader cannot see the page to check. A model that turns "step free
along its entire length" into "fully accessible" has told a disabled user
something false about a place they may be about to travel to. Everything the
glove says has to be something the page actually said. Read this section before
editing the prompt.

Request config: `temperature 0.0`, `maxOutputTokens 120`.

### 6.4 Failure handling

| Condition | Behaviour |
|---|---|
| 404 | `_repair_model()` — fetch `GET /v1beta/models`, pick a working `generateContent` model, retry |
| 400 mentioning "thinking" | drop `thinkingConfig` and retry once |
| 429 | `last_reason = "rate limited"` and **break — no retry** |
| timeout / unreachable / empty candidate | fall back to the head of the page |

The 429 rule exists because the limit is **per minute**, not daily. Retrying a
rate limit immediately guarantees another one; backing off cleanly means the next
page read usually succeeds.

`summarize()` **never raises.** It always returns `(text, source, ms)` where
`source` is `"gemini"` or `"fallback"`.

### 6.5 Caching

Keyed by `sha1(text) + max_chars`, `CACHE_MAX = 64`, `last_reason = "cached"`,
and a cached hit reports `ms = 0`.

**Fallbacks are never cached.** One network blip would otherwise poison that page
for the rest of the session — every later read would serve the degraded text
from cache and never retry. That behaviour is pinned by a test.

### 6.6 `to_glove_text(s, max_chars)`

Forces any string down to lowercase a–z and single spaces and truncates on a word
boundary. Applied to **both** Gemini's answer and the fallback, so the two paths
produce the same shape of text. This is the last line of defence against a model
that ignores rule 4 — and models do, regularly.

---

## 7. The ESP32 firmware

`firmware/braille_glove/braille_glove.ino`, 545 lines. Arduino IDE, board
**ESP32 Dev Module**, library **Adafruit DRV2605**, 115200 baud.

> **This has never run on real hardware.** All 64 firmware tests pass against
> host shims, which proves logic only — not I2C timing, not how a motor feels.

### 7.1 Hardware

**Output.** Six DRV2605L haptic drivers, each on its own channel of a PCA9548A
I2C mux at `0x70`. The mux is necessary because every DRV2605L has the fixed
address `0x5A` and cannot be changed; selecting channel `ch` means writing
`1 << ch` to the mux. Motors are driven in **real-time playback mode**
(`setRealtimeValue`) rather than the built-in effect library, because a braille
cell needs a plain sustained buzz of a known length, not a designed waveform.

**Input.** Five FSRs — thumb, index, middle, ring, pinky.

| Signal | GPIO |
|---|---|
| I2C SDA / SCL | 21 / 22 |
| Thumb | 25 |
| Index | 33 |
| Middle | 32 |
| Ring | 35 |
| Pinky | 34 |

### 7.2 WiFi is forced off

```cpp
WiFi.mode(WIFI_OFF);   // in setup()
```

The thumb FSR is on **GPIO 25, which is ADC2**, and on the ESP32 ADC2 stops
working the moment WiFi is enabled. The thumb switches modes and triggers page
reads, so losing it loses the whole input side. If the thumb reads garbage, move
it to GPIO 36 or 39 (both ADC1) rather than re-enabling WiFi.

### 7.3 Nothing in `loop()` may block

There is **no `delay()`** in the main loop. Motor sequencing, FSR sampling and
serial parsing all run off `millis()` through a non-blocking `Step`-sequence
player (`seqStart` / `seqTick` / `seqStop`). The reason is concrete: a 400 ms
blocking pulse would swallow any fingertip press that happened during it, so the
glove would feel like it was dropping input at random. The only `delay()` is in
`calibrateFsr()`, which runs once in `setup()`.

### 7.4 Input: two strokes per character

A character is entered as **two strokes**. Index, middle and ring map to dots
1–3; the first stroke latches the left column, the second supplies the right:

```cpp
if (half == HALF_LEFT) {
  leftLatched = mask & 0x07;            // dots 1-3
  half = HALF_RIGHT;
  playCell(leftLatched, ECHO_MS);       // left-column confirmation
} else {
  const uint8_t cell = leftLatched | ((mask & 0x07) << 3);
  commitCell(cell);                     // echoes the whole cell back
}
```

Every stroke is confirmed on the palm immediately — this is why input lives in
firmware.

| Gesture | Effect |
|---|---|
| Thumb single tap, READ mode | `EVT THUMB_TAP` → host reads the page |
| Thumb single tap, INPUT mode | commit with an empty right column (needed for `a`, `b`, `k`…) |
| Thumb triple tap | toggle READ / INPUT |
| Pinky tap | space |
| Pinky long press (1000 ms) | backspace |
| 5 s idle mid-character | `CANCEL_MS` expires the half-entered letter |

FSR edges use **hysteresis plus debounce**: press at `baseline + PRESS_DELTA`
(350), release only below `baseline + RELEASE_DELTA` (200), with a 25 ms
debounce. Baselines are measured at boot over `CALIB_SAMPLES = 64` readings,
because FSR resting values depend on how tightly the glove is worn and differ
every time it is put on.

### 7.5 Bench constants

All at the top of the file:

| Constant | Value | Note |
|---|---|---|
| `DOT_TO_CHANNEL` | `{0,1,2,3,4,5}` | **unverified** — the one table to fix by feel |
| `MOTOR_IS_LRA` | `false` | `true` for LRA, `false` for ERM coin motors |
| `AMPLITUDE` | 110 | 0–127 in RTP mode |
| `PRESS_DELTA` | 350 | ADC counts above baseline = pressed |
| `RELEASE_DELTA` | 200 | hysteresis floor |
| `DEBOUNCE_MS` | 25 | |
| `DEFAULT_DUR_MS` | 400 | host overrides with `DUR` |
| `ECHO_MS` | 220 | palm confirmation pulses |
| `TAP_MAX_MS` | 220 | shorter press = a tap |
| `MULTI_TAP_MS` | 250 | gap allowed between taps |
| `LONG_PRESS_MS` | 1000 | pinky held = backspace |
| `CANCEL_MS` | 5000 | half-entered letter expires |

`DOT_TO_CHANNEL` is marked "confirm physically" in the spec and is almost
certainly wrong until someone wears the glove. If letters come out scrambled,
send `TEST`, feel which motor fires in which order, and reorder this array —
do not go looking for a bug in the converter.

### 7.6 Bring-up commands

`SCAN` re-probes the drivers and reports a bitmask. `TEST` fires each motor in
turn. `PING` replies `EVT READY`.

---

## 8. The serial protocol

115200 baud, newline-terminated ASCII.

### Host → glove

| Command | Meaning |
|---|---|
| `CELL <0-63>` | pulse this cell for `DUR` ms, then stop |
| `DUR <ms>` | set the pulse length |
| `CLEAR` | all motors off now (interrupt) |
| `MODE <READ\|INPUT>` | `READ` ignores the finger FSRs |
| `PATTERN <name>` | `MODE_READ` \| `MODE_INPUT` \| `ERROR` \| `CANCEL` |
| `SCAN` | re-probe drivers, report |
| `TEST` | fire each motor in turn |
| `PING` | replies `EVT READY` |

Anything else gets `EVT ERROR unknown command <text>`.

### Glove → host

| Line | Meaning |
|---|---|
| `IN: <0-63>` | committed character (0 = space) |
| `IN: BS` | backspace |
| `EVT THUMB_TAP` | read mode: host should extract the page |
| `EVT MODE READ\|INPUT` | mode changed |
| `EVT READY` | booted |
| `EVT DRIVERS <mask>` | which drivers answered, e.g. `0x3F` for all six |
| `EVT ERROR <text>` | anything wrong |

### Changing it — three places must agree

1. the firmware's command parser,
2. `bridge/bridge.py`,
3. **both** paired tests.

`bridge/test_protocol.py` asserts what the bridge writes and parses matches the
protocol; `firmware/test/test_firmware.cpp` feeds **the same command strings** to
the real firmware parser and asserts it does not answer
`EVT ERROR unknown command`. The two halves were written against the spec rather
than against each other, so these tests are the only thing keeping them in sync.
**Update both test files together.**

---

## 9. Testing

160 tests across four suites. None needs hardware, an API key or a network
connection.

```bash
./run-tests.sh
```

> **`run-tests.sh` pipes each suite through `tail -2`, so its exit code does not
> reflect failures.** Read the `N passed, M failed` lines, or run a suite
> directly — each suite exits non-zero on failure.

Individually:

```bash
node test-braille.js
```

```bash
python bridge/test_gemini.py
```

```bash
python bridge/test_protocol.py
```

```bash
g++ -std=c++17 -I firmware/test/shim -Wall -Wno-unused-function firmware/test/test_firmware.cpp -o firmware/test/test_firmware.exe && ./firmware/test/test_firmware.exe
```

| Suite | Tests | Covers |
|---|---|---|
| `test-braille.js` | 36 | the converter, both directions, flags, dropped chars |
| `bridge/test_gemini.py` | 34 | HTTP path, prompt contents, cache, 404 repair, timeout, sanitizer |
| `bridge/test_protocol.py` | 26 | both directions of the wire format, byte-table agreement |
| `firmware/test/test_firmware.cpp` | 64 | strokes, taps, state machine, command parser |

These are **hand-rolled scripts** — no test framework, no way to run a single
case. They are built on `eq` / `check` helpers that print `ok` or `FAIL` and
count. Add new cases in the same style in the matching file.

### How the firmware is tested without an ESP32

`firmware/test/test_firmware.cpp` `#include`s the `.ino` **unmodified** and
compiles it with g++ against the fakes in `firmware/test/shim/`:

| Shim | Provides |
|---|---|
| `Arduino.h` | virtual clock (`g_millis`, tests advance time themselves), fake ADC map (`g_adc`), a `SerialShim` that records every emitted line with `saw()` / `count()` / `last()` helpers |
| `Wire.h` | I2C with mux channel tracking |
| `WiFi.h` | enough to let `WiFi.mode(WIFI_OFF)` compile |
| `Adafruit_DRV2605.h` | a recording driver |

The virtual clock is what makes this work: a test can jump 1000 ms forward and
assert a long press fired, with no sleeping.

**If the firmware starts using a new Arduino, Wire, WiFi or DRV2605 API, add it
to the shim.** A missing symbol is a compile error, which is the failure mode you
want.

### Suite quirks worth knowing

- `test_gemini.py` runs a **stub HTTP server** pretending to be
  `generativelanguage.googleapis.com`. `known_models` lists what it will serve;
  `made-up-model` is not among them, which is what drives the 404-repair path.
  `QuietServer` and the `handle_one_request` override exist because the timeout
  test hangs up mid-response on purpose and the noise is not a real error.
- The timeout test asserts `ms < 1500` against a 1.5 s stub delay. The bound is
  loose deliberately: the point is that it did not wait for the reply, and a
  tighter bound was flaky under load.
- `setup()` must be re-runnable. An early round of 8 failures came from `setup()`
  relying on static initialisers, so state carried between simulated boots;
  `resetInputState()` fixed it. Keep calling it from `setup()`.

---

## 10. Test pages and the standalone converter

Serve them over HTTP — content scripts do not run on `file://`:

```bash
python -m http.server 8123
```

| Page | Purpose |
|---|---|
| `demo.html` | buttons, links, a form, images with alt text, long prose — the hover workout |
| `article.html` | nav, ads, a sidebar and a footer — for testing `article` scope extraction |
| `converter.html` | a standalone text→braille workbench |

**`converter.html` opens its own WebSocket to the bridge and works without the
extension at all.** That is its real job: it is the fallback for a demo. If the
extension misbehaves — a service worker that will not wake, a bad reload — you
can still type text and drive the glove from this page.

---

## 11. Configuration reference

### Extension settings (`chrome.storage.local`)

| Key | Default | Effect |
|---|---|---|
| `enabled` | `true` | mode 1 (hover) on/off — **does not** affect page reading |
| `bridgeUrl` | `ws://127.0.0.1:8787` | first bridge to try |
| `cellMs` | 400 | vibration per cell |
| `gapMs` | 150 | silence between cells |
| `spaceMs` | 400 | extra pause for a blank cell |
| `readCellMs` | 600 | per-cell time for page reads |
| `dwellMs` | 250 | hover dwell before output starts |
| `maxChars` | 20 | label truncation |
| `showOverlay` | `true` | on-screen mirror of the palm |
| `summarize` | `true` | send page text through Gemini first |
| `summaryChars` | 140 | target summary length |
| `scope` | `full` | `article` \| `full` \| `visible` |
| `sayType` | `true` | prefix labels with button / link / field |
| `logToPage` | `false` | also print byte sequences to the page console |

Remember: each file has its own copy of `DEFAULTS`. Add a new setting to every
file that reads it.

### Environment

| Variable | Used by | Effect |
|---|---|---|
| `GEMINI_API_KEY` | bridge | enables summarization; absent = raw text fallback |
| `GEMINI_MODEL` | bridge | overrides the default model |

---

## 12. Troubleshooting

**Nothing happens on hover.**
Is the page served over HTTP? Content scripts do not run on `file://`. Is mode 1
enabled in the popup? Is a page read in progress — that suspends hover by design.

**"No API key on the bridge" but you set the key.**
You are almost certainly connected to a **stale bridge** from an earlier run on a
lower port. The popup distinguishes this: if it says *"too old to summarize"*,
kill the old process and restart from the current folder. Check which ports are
listening in the 8787–8796 range.

**Summaries never arrive.**
Check `thinkingConfig: {thinkingBudget: 0}` is still in `gemini.py` — without it
calls take 40+ seconds. Then check the bridge log for `rate limited` (429s are
per *minute*; wait and retry) and run `python bridge/bridge.py --list-models` to
confirm the key can call the configured model.

**Letters come out scrambled on the glove.**
`DOT_TO_CHANNEL` in the firmware, not the converter. Send `TEST`, feel the order,
reorder the array.

**The thumb reads garbage.**
GPIO 25 is ADC2. Confirm WiFi is off, or move the thumb to GPIO 36 or 39.

**Motors are weak or the ESP32 browns out.**
Power the motors from a separate supply with a common ground. Six motors on the
ESP32's regulator will not hold up.

**`run-tests.sh` exits 0 but something is broken.**
Known: the `tail -2` pipeline hides exit codes. Read the `N passed, M failed`
lines or run the suite directly.

**A page read cannot be stopped.**
Use **Stop** in the popup. Pointer movement deliberately does not cancel it.

---

## 13. Security and privacy

- **The Gemini API key never reaches the extension.** It lives only in the
  bridge's environment. Extension source is readable by anyone who installs it;
  this is the single most important constraint in the project.
- **Passwords are never read out.** `controlValue()` returns `''` for
  `type === 'password'`, unconditionally.
- **The bridge binds `127.0.0.1` by default.** Keep it that way. It accepts
  unauthenticated commands, so exposing it on a LAN would let anyone drive the
  glove and spend the API key.
- `.gitignore` excludes `.env`, `*.key`, `.claude/` and build artifacts. Set the
  key inline on the command line rather than writing it to a file.
- A key that has appeared in a chat transcript, a screenshot or a demo recording
  should be **rotated** afterwards.

---

## 14. Known gaps

Honest status, so nobody is surprised at a demo:

- **The firmware has never run on an ESP32.** 64 tests pass against shims, which
  proves logic and nothing about I2C timing or feel.
- **`DOT_TO_CHANNEL` is unverified** and likely needs reordering.
- **Whole-page summarization has not been confirmed live** — the attempt hit a
  429. The code path is tested against the stub; the real round trip is not.
- **The extension has not been loaded in a real Chrome profile** end-to-end.
- No single-test runner, and `run-tests.sh` masks exit codes.
- The letter table is duplicated between `braille.js` and `bridge.py`.
