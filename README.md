# Braille Glove — hover-to-braille Chrome extension

Mouse over anything on a web page; after a short dwell its label is converted to
braille cells and pushed to the glove. Implements steps 2, 3, 4 and 5 of the
build priority in `context.md`.

```
Chrome extension  <-- ws://127.0.0.1:8787 -->  bridge.py  <-- USB serial -->  ESP32
 hover reader                                   serial owner                  PCA9548A
 text -> cells                                  Gemini proxy (later)          6x DRV2605L
 timing + interrupt
```

Host owns the thinking (conversion, pacing, interrupt); the ESP32 just pulses
cells on command, exactly as in context.md 9.1.

## Run it

**1. Start the bridge.** No hardware needed yet — `--mock` draws each cell in
the terminal, so the whole browser side is demoable before the glove is wired.

```bash
pip install websockets pyserial
```

```bash
python bridge/bridge.py --mock
```

With the ESP32 plugged in (the port is auto-detected; `--list` shows the options):

```bash
python bridge/bridge.py
```

**2. Load the extension.** `chrome://extensions` → Developer mode on → *Load
unpacked* → pick the `extension/` folder.

**3. Open a page and hover.** `demo.html` has buttons, links, a form, images
with alt text and a long paragraph for the extract path. Serve it (Chrome
content scripts don't run on `file://` without extra permission):

```bash
python -m http.server 8123
```

then open `http://localhost:8123/demo.html` to hover, or
`http://localhost:8123/converter.html` to type text and watch it become cells.

The extension popup shows bridge status, live cell, and the timing knobs.

## What's in here

| File | Role |
|---|---|
| `firmware/braille_glove/braille_glove.ino` | The ESP32 firmware: motors, FSRs, input state machine. |
| `firmware/test/` | Host harness: compiles the firmware with g++ against Arduino shims. |
| `bridge/test_protocol.py` | Checks the bridge and firmware agree on the wire format. |
| `run-tests.sh` | Runs all 160 tests. |
| `converter.html` | **Text → braille workbench.** Type anything, see the cells, play them on the glove. |
| `extension/braille.js` | The converter itself: Grade 1 tables, cell bytes (bit0 = dot 1), Unicode braille, timing estimate. Shared by the content script, the worker and the workbench. |
| `test-braille.js` | 36 checks against context.md and UEB. `node test-braille.js` |
| `extension/content.js` | Hover reader: dwell, label resolution, truncation, interrupt, page extraction, on-screen cell overlay. |
| `extension/background.js` | WebSocket to the bridge with auto-reconnect, plus the playback engine (queue, per-cell timing, cancel). |
| `extension/popup.html/.js` | Status, sliders, byte output panel with copy/history, test sender, "read page". |
| `bridge/gemini.py` | The summarization prompt and the Gemini client: 3s budget, fallback, model repair, output sanitizer. |
| `bridge/test_gemini.py` | 21 checks against a stub API. No key needed. |
| `article.html` | A page with nav, ads, a sidebar and a footer, for testing extraction. |
| `bridge/bridge.py` | WebSocket ⟷ serial. Decodes `IN: <n>` back to letters, forwards `EVT` lines. `--mock` for no hardware. |
| `demo.html` | Rehearsal page. |

## Element type cues (5.3)

Hovering now says *what* a thing is before *what it says*. A screen reader
announces "Save, button"; the glove puts the type **first**, because braille
arrives one cell at a time and knowing you are on a button after two words
beats learning it after ten. Toggle it with *say element type on hover*.

| Hovering | The glove reads |
|---|---|
| `<button>save</button>` | `button save` |
| `<button aria-label="delete file">Trash</button>` | `button delete file` |
| `<a href="#help">help</a>` | `link help` |
| empty email input | `field email empty` |
| the same input holding "aditya" | `field name aditya` |
| `<select>` with Dayton chosen | `menu city dayton` |
| `<img alt="orange square">` | `image orange square` |
| `<h2>Buttons</h2>` | `heading buttons` |
| a list item or paragraph | unchanged, no cue |

Type words are kept short (`field`, `menu`, `link`) because every letter is
about half a second. Checkboxes and radios also report `checked` /
`not checked`, and an empty text field reports `empty`, since both change
what the user would do next. **Passwords are never read out.** The label is
truncated *before* the type word is added, so a long label can never squeeze
out the word that makes it understandable.

Two things this fixed along the way: `<label>City <select>…</select></label>`
used to read as "city cincinnati dayton columbus", because the label element
contains the control's own text — the name is now taken from the label with
nested controls removed. And a filled field used to read only its label,
losing the value.

## Page capture panel (testing)

The popup has a **Page capture — DOM, for testing** section: press *Capture
page* and it runs the current scope against the active tab and reports

```
full · 1568 chars · 1535 cells · 17m 41s on the palm
```

with the captured text below it, plus *Copy text* and *Copy bytes*. It is
there to check what the glove would receive before any hardware exists —
the cell count and the time estimate are the useful part, since they say
immediately whether a page is readable at all. (1,535 cells is not: that is
what summarization is for.)

## Firmware (ESP32)

`firmware/braille_glove/braille_glove.ino`. Open it in the Arduino IDE,
select **ESP32 Dev Module**, install **Adafruit DRV2605 Library** from the
Library Manager, and flash at 115200.

**Nothing in the main loop blocks.** No `delay()` after setup: motor timing,
FSR sampling and serial parsing all run off `millis()`. A 600ms pulse that
blocked would swallow a fingertip press, and a half-received command that
blocked would stall the motors.

### Bring-up order

1. Flash, open the Serial Monitor at 115200. You should see
   `EVT READY`, `EVT DRIVERS 0x3F`, `EVT MODE READ`. A bit missing from
   that mask means a driver is not answering; it names the channel.
2. Type `TEST`. Each motor fires alone, dot 1 to dot 6, 260ms each. **Feel
   the order.** If it is not top-left, middle-left, bottom-left, top-right,
   middle-right, bottom-right, fix `DOT_TO_CHANNEL` at the top of the file
   and reflash. This is the one table context.md marks as unconfirmed, and
   getting it wrong turns every letter into a different letter.
3. Type `CELL 25`. Dots 1, 4 and 5 should fire together: the letter `d`.
   `CELL 61` is `y`. `CLEAR` stops everything.
4. Only then start the bridge and let the host drive it.

### Settings worth knowing

All at the top of the file. `MOTOR_IS_LRA` must match the motors (false for
ERM coin). `AMPLITUDE` is 0-127. `PRESS_DELTA` / `RELEASE_DELTA` are the FSR
thresholds in ADC counts above the baseline measured at boot — **keep your
hands off the glove while it powers up**, or the baseline calibrates to a
pressed finger.

WiFi is switched off in `setup()` on purpose: the thumb is on GPIO 25, which
is ADC2, and ADC2 stops working the moment the radio comes up.

### Extra commands, beyond the protocol in 9.3

`SCAN` re-probes the drivers, `TEST` runs the motor sweep, `PING` answers
`EVT READY`. The bridge forwards anything it does not recognise to the
extension as a plain `serial` line, so these are safe to use mid-session.

### Testing it without hardware

The firmware is compiled and exercised on the laptop, against a shim that
provides a virtual clock, fake ADC pins and a recording Serial:

```bash
./run-tests.sh          # everything: 160 tests
```

64 of those are the firmware: cell output, CLEAR, DUR, bad commands, the
read-mode lockout, thumb tap and triple tap, two-stroke entry of `y` and
`a`, pinky space and backspace, the 5s cancel, chord latching, debounce,
hysteresis, and a command arriving split across reads while fingers are
moving.

**What this does not prove.** It is a test double, not an emulator. Real I2C
timing, motor feel, vibration bleed between neighbouring motors, FSR
behaviour under an actual fingertip, and power draw with six motors running
are all unmeasured. The firmware has never run on an ESP32. Expect to tune
`PRESS_DELTA`, `AMPLITUDE` and `DOT_TO_CHANNEL` on the bench.

One thing the tests did catch: `setup()` relied on static initialisers for
the input state, so a soft reset was only correct by accident. It now resets
explicitly.

## Byte output (no glove needed)

The glove is still being built, so the extension is its own output device.
Everything works with nothing plugged in: hover a page and the byte sequence
appears in four places at once.

1. **Popup, Byte output panel** — the last sequence with its text and cell
   count, **Copy** for that sequence, **Copy all** for the whole session as
   TSV (`time, source, text, bytes`), **Clear**, and a clickable history of
   the last 40. Status reads *bytes only* rather than an error when no bridge
   is running.
2. **On-page overlay** — the live cell now shows `byte N` under the letter.
3. **Service worker console** — one line per sequence, at
   `chrome://extensions` → *service worker*:
   ```
   [braille] no glove 11  "delete file"  ->  25 17 7 17 30 17 0 11 10 7 17
   ```
4. **Page console** — same thing in the page's own DevTools. Off by default;
   tick *page console* in the popup.

Each record carries `sent: false` while no bridge is connected, so it is
always clear whether bytes reached hardware or stopped at the browser.

Timing still runs exactly as it will with the glove — cells are paced, a new
hover still cancels mid-sequence — so what you read in the panel is what the
palm will feel. When the glove is ready, start the bridge and the same bytes
go out over serial with no change to the extension.

## The converter

`extension/braille.js` is the one implementation of text → braille. Open
`converter.html` to use it by hand: type text, watch the cells appear, and
press **Play on glove** to push them through the bridge. It needs no
extension, so it is also the safe fallback if the extension misbehaves on
stage.

```js
Braille.textToCells('hi')     // [{ch:'h', n:19, dots:[1,2,5], kind:'letter', unicode:'⠓'}, ...]
Braille.textToBytes('hi')     // [19, 10]   <- what goes over the wire
Braille.textToUnicode('hi')   // '⠓⠊'
Braille.byteToChar(61)        // 'y'        <- inverse, for input mode
Braille.estimateMs(cells)     // playback length in ms
Braille.droppedChars('a1!')   // {'1':1, '!':1}
```

**Defaults are a–z and spaces**, per "basics first". Three extras are
implemented but off unless you ask:

| Option | What it adds | Cells |
|---|---|---|
| `capitals` | dot 6 before a capital letter | `Ab` → `32, 1, 3` |
| `numbers` | dots 3456 once per digit run, digits reuse a–j | `42` → `60, 25, 3` |
| `punctuation` | UEB `, ; : . ! ? ' -` | `.` → `50` |

Numeric mode opens at the first digit and closes at the next space or letter,
so `12a3` is `NUM 1 2 a NUM 3`. The checkboxes in `converter.html` set them;
the extension stays on basics. Verified: none of the eight punctuation cells
collides with a letter, and all 26 letters round-trip byte → char.

## The two modes

The popup is organised around them, and they are independent — turning the
hover reader off does **not** stop you reading a page.

**Mode 1 — mouse hover.** Move the mouse, pause past the dwell, and whatever
is under the cursor is brailled, prefixed with its type (`button save`).
Switched by *Enabled*. Continuous and interrupt-driven: a new target cancels
the old one.

**Mode 2 — read the page.** Press **Read whole page** in the popup (or tap
the thumb on the glove). It captures the page via the DOM, optionally
summarizes it, and plays the lot. *Covers* decides how much: whole page, on
screen now, or main article. While it runs the popup shows

```
cell 312 of 1535 · 20%
```

and **Stop** ends it. Verified: with *Enabled* unticked, hovering produces
nothing while Read whole page still returns 1,535 cells with progress
reported from cell 1.

**Mode 2 owns the motors while it runs.** Hover is suspended for the whole
read — otherwise the first twitch of the mouse would cancel it, since a new
hover target is an interrupt by design. The popup shows *paused while the
page is being read* under Mode 1, and *Stop* is the way out. Verified by
hovering four different elements mid-read: zero hover sequences emitted, the
read carried on uninterrupted.

### Reading the bridge status line

Three different things used to look alike. They now read differently:

| Line in the popup | What it means | Fix |
|---|---|---|
| `Gemini ready (gemini-3.6-flash)` | summarizing | — |
| `Bridge has no GEMINI_API_KEY — reading the raw text` | bridge started without the key | set the key, restart the bridge |
| `This bridge is too old to summarize` | connected to a bridge from before summarize existed | restart it from the current folder |

The last one is detected from the bridge's own handshake: a current bridge
reports a `gemini` field, an old one does not. It catches the easy mistake of
leaving an old `bridge.py` running on the default port 8787 while editing a
newer one.

The result line under it now says what happened rather than printing two
numbers:

```
full → Gemini: 1568 chars summarized to 57  "city opened a step free..."
visible → page text: 402 chars, not summarized  "Braille Glove Demo Page..."
```

## What a page read covers

`extractPage()` throws most of a page away on purpose. That is right for a
summary and wrong when you want *everything*, so **Covers** in the popup
picks the scope:

| Scope | What it reads | On `article.html` |
|---|---|---|
| **Whole page** (default) | the entire document, scrolled or not | 1,568 chars |
| **On screen now** | only what is in the viewport, the DOM equivalent of a screenshot | 589 at the top, 634 at the bottom |
| **Main article** | the Readability-style pass: furniture stripped | 1,079 chars |

No OCR and no screenshot: the text is already in the DOM, so a screen capture
would only make it harder to read. "On screen now" filters by
`getBoundingClientRect` against the viewport, so scrolling changes what it
returns — nav at the top of the page, footer at the bottom.

Both screen scopes walk **text nodes**, not `innerText` on containers, so
nothing is counted twice, and they pick up what `innerText` silently drops:

| | `innerText` | whole-page capture |
|---|---|---|
| `alt` text on images | missing | **read** |
| input placeholders | missing | **read** |
| selected `<option>` | read | read |
| `aria-label` on a control | missing | **wins over the visible text** |

That last row matters: `<button aria-label="delete file">Trash</button>` reads
as *delete file*, the way a screen reader would announce it. An aria-label
only replaces content for controls and leaves, never for a labelled
container, or the container's contents would vanish. Script, style, hidden
and `aria-hidden` subtrees are skipped; open shadow DOM is followed.

Measured on `demo.html`: 1,029 chars captured against 979 from `innerText`,
with no duplication.

**A whole page is a lot of braille.** `article.html` is 1,568 characters,
about 20 minutes on the palm unsummarized. Whole-page scope is really meant
to be paired with summarization; with Gemini off, use *Main article* or
expect to interrupt.

## Page → Gemini → braille (8.2, 8.3)

Thumb tap, or **Read page** in the popup, runs this:

```
DOM  →  content extractor  →  bridge  →  Gemini  →  sanitize  →  cells  →  glove
        strips nav/ads/      key lives   3s budget   a-z only
        footer/sidebar       here
```

**The key never goes near the extension.** The extension sends
`{"cmd":"SUMMARIZE", text, title, maxChars}` over the WebSocket it already
has; the bridge holds `GEMINI_API_KEY` and makes the HTTPS call. That also
means no extra host permission and no CORS.

```bash
set GEMINI_API_KEY=your-key-here && python bridge/bridge.py --mock
```

Without a key nothing breaks — it reads the page text itself and says so in
the popup.

**Thinking is disabled** (`thinkingBudget: 0`). This matters more than
anything else here: current Flash models think before answering by default,
which took this exact call from about a second to over forty. Measured on
this project's key with `article.html`:

| model | warm best | note |
|---|---|---|
| `gemini-3.6-flash` | 973ms | **default** |
| `gemini-3-flash-preview` | 885ms | preview, not a demo default |
| `gemini-3.1-flash-lite` | 963ms | |
| `gemini-3.5-flash` | 1092ms | |
| `gemini-flash-latest` | — | never answered within 40s on this key |

The `gemini-flash-latest` alias is therefore **not** the default, even though
it tracks the newest Flash. The 2.5 models are listed by the API but return
404 on `generateContent`. Timeout is 5s rather than the 3s in context.md,
because the first call of a session runs ~3.5s while warm calls run ~1s.

### Making summarization actually happen

Three things got in the way in practice. All three are handled now.

**1. A stale bridge on the default port.** The old bridge answered, looked
connected, and silently never summarized. Now a bridge that finds its port
taken **moves to the next free one and says so**:

```
[bridge] port 8787 is busy, trying 8788
[bridge] NOTE: 8787 was taken - something else is still running there
[bridge] listening on ws://127.0.0.1:8789
```

**2. The extension then had to find it.** It now **probes 8787-8796** and
keeps the best bridge it sees: a current one beats an outdated one, and it
only settles for outdated if nothing better answers. Verified with the
extension configured to the stale 8787 and a good bridge on 8789 — it
skipped the stale ones unaided, settled on 8789, and summarized. Hover
over the status text to see which bridge won.

**3. Free-tier rate limits.** Reading the same page twice is the normal case
while rehearsing, so summaries are **cached by text and length**. A repeat
returns in 0ms and spends no quota. Fallbacks are never cached, so one blip
cannot poison a page for the rest of the session.

That last one is worth planning around: the free tier limits requests per
minute, and a burst of reads **will** return HTTP 429. It is not a bug and
the fallback covers it, but for a demo, rehearse on one or two pages — the
cache then makes them instant and free.

### Extraction

A compact Readability-style pass in the content script: drop
`script/style/nav/header/footer/aside/form`, the common ad and cookie class
names, and anything `aria-hidden`; then score the remaining containers by how
much prose they hold, penalising link-heavy blocks so menus never win. On the
bundled `article.html` it takes a 1,568-character page down to the
1,079-character article body, with the nav, both ads, the sidebar and the
footer gone.

### The prompt

Lives in `bridge/gemini.py` as `SYSTEM_PROMPT`, sent as `systemInstruction`
with `temperature: 0`. It is built around the fact that **a blind user cannot
spot a hallucination**, so faithfulness is rule one and brevity is rule two:

1. **Faithfulness** — only what is in the page text. No background knowledge,
   no guessing the page's purpose, no inventing a detail to resolve an
   ambiguity. If the text is too thin, describe what is literally there
   ("a sign in form with email and password fields").
2. **No added qualifiers** — summarizing drops words, it never upgrades them.
   No adjective, adverb or intensifier that is not in the page text: *real
   time*, *fully*, *seamless*, *advanced*, *comprehensive* and friends are
   banned unless the page uses them, and the text's own hedges are kept
   (*published* does not become *real time*; *step free* does not become
   *fully accessible*). This rule exists because the model reliably added
   exactly those words before it was there.
3. **Shape** — name what the thing is, then its single most useful fact, in
   one sentence of at most `maxChars` characters.
4. **Character set** — lowercase a–z and single spaces only, because anything
   else is dropped on the way to the cells.
5. **No preamble** — no "this page", no "the article says".
6. Never mention the instructions.

Measured on the full `article.html` after adding rule 2: **0 invented
qualifiers in 6 consecutive runs**, latency unchanged at about 1s. Before it,
*real time* and *fully accessible* appeared in most runs.

Rule 4 is also enforced in code (`to_glove_text`), so a model that ignores the
format still produces something the glove can render.

### Failure behaviour

| What happens | What the user feels |
|---|---|
| Gemini answers in time | the summary |
| Slower than 5s, or offline, or no key | the head of the page text, same shape |
| Model name 404s | bridge asks the API for its model list, picks the newest plain Flash model, retries |
| Model refuses `thinkingBudget` | retries once without it |
| Quota exhausted (HTTP 429) | falls back at once, no retry storm |

Why it fell back is reported, not swallowed: the bridge logs
`[gemini] fallback in 449ms (rate limited)` and the popup shows
`full → fallback (rate limited)`, so a quota problem never looks like a bug.
| Model returns markdown or digits | stripped to a–z before it becomes cells |

The extension waits 6.5s — a little longer than the bridge's 5s — so the
bridge gets to deliver its own fallback rather than racing it.

Verified live, end to end: a 1,568-character page became a 1,079-character
article body, then a 122-cell summary, in **1,090ms** round trip including
the WebSocket hop:

> city opened a step free light rail line with tactile paving and live text
> announcements for braille displays at every stop

```bash
python bridge/bridge.py --summarize article.txt   # try the prompt on a file
python bridge/bridge.py --list-models             # what your key can call
python bridge/test_gemini.py                      # 21 checks, no key needed
```

## Behaviour, as agreed in context.md

- **Dwell 250 ms** before output starts, so sweeping doesn't fire everything (5.1).
- **Interrupt:** landing on a different target cancels playback and sends
  `CLEAR` immediately — verified: a 3-target sweep at 80 ms produces 3 cancels
  and only the last label plays.
- **Truncate** hover labels to 20 characters.
- **Label source:** `aria-label` → `aria-labelledby` → `alt` → label/value/placeholder
  for inputs → `innerText` → `title`.
- **Text cleanup:** lowercase, drop everything outside a–z, collapse whitespace,
  space = blank cell (byte 0) with a longer pause (3.4).
- **Timing:** 400 ms per cell for hover, 600 ms for extracted page text, 150 ms gap.
  All adjustable in the popup.

## Serial protocol (9.3)

Extension → bridge is JSON; the bridge writes the ASCII lines:

| JSON | serial line |
|---|---|
| `{"cmd":"CELL","n":25}` | `CELL 25` |
| `{"cmd":"CLEAR"}` | `CLEAR` |
| `{"cmd":"DUR","ms":400}` | `DUR 400` |
| `{"cmd":"MODE","mode":"READ"}` | `MODE READ` |
| `{"cmd":"PATTERN","name":"ERROR"}` | `PATTERN ERROR` |

ESP32 → extension, already wired up so the firmware has somewhere to talk to:

| serial line | JSON to the extension |
|---|---|
| `IN: 61` | `{"type":"char","ch":"y","n":61}` |
| `IN: BS` | `{"type":"backspace"}` |
| `EVT THUMB_TAP` | `{"type":"extract"}` → extension extracts the page and reads it |
| `EVT MODE INPUT` | `{"type":"mode","mode":"INPUT"}` → playback stops |

An `IN:` byte that maps to no letter gets `PATTERN ERROR` sent back and types
nothing (9.2a step 4). `--type-keys` additionally types committed letters into
the focused window via pynput.

## Known gap

Summarization helps but does not make page reading quick. A 140-character
summary is about 122 cells, which at 600ms plus a 150ms gap is **about 90
seconds** on the palm. If that is too long for the demo, drop *Summary length*
in the popup to 60 — about 45 seconds — or the cell time to 400ms.

## Not built yet

Nothing in the build order of context.md section 10 is unwritten. What
remains is bench work: wiring the glove, confirming `DOT_TO_CHANNEL` by
feel, tuning the FSR thresholds, and powering the motors from their own
supply with a common ground.
