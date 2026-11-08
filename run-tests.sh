#!/usr/bin/env bash
# Every test in the project. No hardware, no API key, no network required.
set -u
cd "$(dirname "$0")"
fail=0

echo "=== braille converter ==="
node test-braille.js | tail -2 || fail=1

echo "=== gemini client (stub API) ==="
python bridge/test_gemini.py | tail -2 || fail=1

echo "=== bridge <-> firmware protocol ==="
python bridge/test_protocol.py | tail -2 || fail=1

echo "=== esp32 firmware (host shims) ==="
if command -v g++ >/dev/null 2>&1; then
  g++ -std=c++17 -I firmware/test/shim -Wall -Wno-unused-function \
      firmware/test/test_firmware.cpp -o firmware/test/test_firmware.exe \
    && ./firmware/test/test_firmware.exe | tail -2 || fail=1
else
  echo "  skipped: g++ not installed"
fi

exit $fail
