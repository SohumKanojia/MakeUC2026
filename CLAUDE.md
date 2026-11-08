# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A MakeUC hackathon project: a haptic braille glove. A Chrome extension turns whatever is under the mouse (or a whole page) into braille cells, a Python bridge relays them over USB serial, and an ESP32 pulses six motors on the palm. Fingertip FSRs on the glove type characters back.

```
Chrome extension (MV3)  <-- ws://127.0.0.1:8787 -->  bridge/bridge.py  <-- USB serial 115200 -->  ESP32
```

Comments throughout cite section numbers of `context.md` (e.g. "context.md 9.3"). That spec is **not in the repo**, so the README and the code comments are the only record of what it says.

## Commands

No build step, bundler, linter or package manager. On Windows, run shell scripts from Git Bash.

```bash
./run-tests.sh                       # every suite; no hardware, API key or network needed
node test-braille.js                 # converter (extension/braille.js)
python bridge/test_gemini.py         # Gemini client against a local stub HTTP server
python bridge/test_protocol.py       # bridge side of the wire format
g++ -std=c++17 -I firmware/test/shim -Wall -Wno-unused-function \
    firmware/test/test_firmware.cpp -o firmware/test/test_firmware.exe && ./firmware/test/test_firmware.exe
```

`run-tests.sh` pipes each suite through `tail -2`, so **its exit code does not reflect failures**. Read the `N passed, M failed` lines, or run a suite directly; each suite exits non-zero on failure. The tests are hand-rolled scripts (no test framework, no way to run a single case), built on `eq`/`check` helpers that print `ok` / `FAIL`. Add new cases in the same style in the matching file.

Running it:

```bash
pip install -r bridge/requirements.txt
python bridge/bridge.py --mock               # no hardware: draws each cell in the terminal
python bridge/bridge.py                      # real ESP32, port auto-detected (--list, --port COM5)
python bridge/bridge.py --summarize FILE     # try the Gemini prompt on a text file
python bridge/bridge.py --list-models        # what the key can call
python -m http.server 8123                   # then open /demo.html, /article.html, /converter.html
```

Load the extension from `chrome://extensions` → Developer mode → Load unpacked → `extension/`. Content scripts don't run on `file://`, so serve the test pages over HTTP. Summarization needs `GEMINI_API_KEY` in the bridge's environment (`GEMINI_MODEL` overrides the model). Without it, everything falls back to the raw page text.

Firmware: Arduino IDE, board "ESP32 Dev Module", library "Adafruit DRV2605", 115200 baud.

## Architecture

**The host does the thinking; the ESP32 only pulses cells when told to.** Text→braille conversion, per-cell pacing and interrupts all live in the extension's service worker. The firmware gets `CELL n` / `DUR ms` / `CLEAR` and nothing smarter. The exception is input: chord entry from the FSRs runs entirely in firmware, because the palm has to confirm each stroke instantly and a USB round trip is too slow for that.

### Cell encoding (used everywhere)

A cell is one byte, `bit0 = dot 1 … bit5 = dot 6`. The Unicode braille char is `U+2800 + byte`, and byte 0 is a space (blank cell, longer pause). Text defaults to lowercase a–z plus spaces only. Capitals, digits and punctuation exist in the converter but are opt-in, and the extension stays on basics.

### `extension/braille.js` is the single converter

It is an IIFE that attaches `Braille` to `self`, so the same file loads in four places: the content script (listed in `manifest.json`), the service worker (`importScripts`), `converter.html` (`<script src>`), and Node (`test-braille.js` sets `global.self = {}` and `require`s it). Keep it as a plain script, with no ES modules, `import`/`export` or bundler syntax, or one of those hosts breaks.

`bridge/bridge.py` has its **own copy** of the letter table (`LETTER_DOTS`), used to decode `IN: <n>` from the glove and to draw cells in `--mock`. Change one and you must change the other.

### Extension (`extension/`)

- `content.js`: the hover reader. It waits out a dwell, works out an element's label (aria-label → aria-labelledby → alt → input label/value/placeholder → innerText → title), truncates it, and **then** prefixes the type word (`button`, `link`, `field`, `menu`…), so truncation can never cut the type word off. Passwords are never read. It also does page extraction in three scopes (`full`, `visible`, `article`); `full` and `visible` walk text nodes rather than `innerText`, and `article` is a Readability-style scorer. The on-page cell overlay lives here too.
- `background.js`: owns the WebSocket and the playback engine. Each playback has a token, and a new hover target cancels the current one and sends `CLEAR`. When the configured bridge isn't connected, it probes ports **8787–8796** and keeps the best bridge it finds, using the `hello` handshake: a bridge that reports a `gemini` field beats an outdated one without it. A page read ("mode 2") suspends hover until it finishes or is stopped. Bytes are recorded for the popup even with no bridge, with `sent: false`.
- `popup.js`: status, timing sliders, byte history, page capture, read/stop.
- Messages are `{type: ...}` objects over `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`; see the `switch` statements in `background.js` and `content.js`. Settings live in `chrome.storage.local`, and each file keeps its own `DEFAULTS` object, so add a new setting to every file that reads it.

### Bridge (`bridge/`)

- `bridge.py` turns JSON commands from the extension into ASCII serial lines (`{"cmd":"CELL","n":25}` → `CELL 25`) and serial lines into JSON events (`IN: 61` → `{"type":"char",...}`, `EVT THUMB_TAP` → `{"type":"extract"}`). It forwards unrecognised serial lines as `{"type":"serial"}`. If its WebSocket port is busy, it moves to the next free one and says so.
- `gemini.py` handles `{"cmd":"SUMMARIZE"}`. The API key never reaches the extension. Details that matter:
  - `thinkingBudget: 0` is what keeps a call around 1s instead of 40s.
  - The bridge's timeout is 5s. The extension waits 6.5s on purpose so the bridge can deliver its own fallback, so keep the extension's wait longer than the bridge's timeout.
  - On a 404 it repairs the model name from the model list.
  - Summaries are cached by text and length. Fallbacks are never cached.
  - `to_glove_text` forces the output down to a–z.
  - `SYSTEM_PROMPT` puts faithfulness first and bans qualifiers the page doesn't use. The README explains why each rule exists; read that before changing the prompt.

### Firmware (`firmware/braille_glove/braille_glove.ino`)

- Six DRV2605L drivers share address 0x5A behind a PCA9548A mux.
- Five FSRs handle input: a character is two strokes (left column of dots, then right), thumb taps switch modes and trigger a page read, and the pinky gives space and backspace.
- **Nothing in `loop()` may block.** There is no `delay()`; motor sequencing, FSR sampling and serial parsing all run off `millis()`.
- WiFi is forced off because the thumb FSR is on GPIO 25 (ADC2).
- The constants you tune on the bench (`DOT_TO_CHANNEL`, `AMPLITUDE`, `PRESS_DELTA`, `MOTOR_IS_LRA`) sit at the top of the file.

`firmware/test/test_firmware.cpp` `#include`s the `.ino` unmodified and compiles it against the fakes in `firmware/test/shim/`: a virtual clock, fake ADC pins, a recording Serial, a Wire and mux, and DRV2605. If the firmware starts using a new Arduino, Wire, WiFi or DRV2605 API, add it to the shim. These tests prove logic only, not I2C timing or how the motors feel, and the firmware has not yet run on real hardware.

### Changing the serial protocol

Three places must agree:

1. The firmware's command parser.
2. `bridge.py`.
3. The paired tests: `bridge/test_protocol.py` checks that what the bridge writes and parses matches the protocol, and `test_firmware.cpp` feeds the same command strings to the real firmware parser.

Update both test files together.

## Test pages

- `demo.html`: buttons, links, a form, images with alt text and long prose.
- `article.html`: nav, ads, a sidebar and a footer, for extraction.
- `converter.html`: a standalone text→braille workbench that opens its own WebSocket to the bridge. It works without the extension, so it is the fallback if the extension misbehaves.
