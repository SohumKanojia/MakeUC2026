"""Checks that the bridge and the ESP32 firmware speak the same protocol.

The two halves were written against context.md section 9.3, not against each
other, so this pins the wire format down from the bridge's side: every line
the firmware emits must parse, and every command the bridge writes must be
one the firmware accepts.

The matching half lives in firmware/test/test_firmware.cpp, which feeds these
exact command strings to the real firmware parser and asserts it does not
answer "EVT ERROR unknown command".

    python bridge/test_protocol.py
"""

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

spec = importlib.util.spec_from_file_location("bridge_mod", os.path.join(HERE, "bridge.py"))
bridge_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge_mod)

passes = failures = 0


def check(label, got, want):
    global passes, failures
    if got == want:
        passes += 1
        print("  ok   %s" % label)
    else:
        failures += 1
        print("  FAIL %s\n         got  %r\n         want %r" % (label, got, want))


class CapturingBridge(bridge_mod.Bridge):
    """A bridge with no serial port: writes are recorded instead."""

    def __init__(self):
        bridge_mod.Bridge.__init__(self, {"port": None, "baud": 115200, "mock": True},
                                   typer=None, gem=None)
        self.written = []
        self.link.write_line = self.written.append


def main():
    b = CapturingBridge()

    print("\nfirmware -> host: every line the firmware can emit")
    check("a committed letter", b._parse("IN: 61"), {"type": "char", "ch": "y", "n": 61})
    check("the other worked example", b._parse("IN: 25"), {"type": "char", "ch": "d", "n": 25})
    check("a space", b._parse("IN: 0"), {"type": "char", "ch": " ", "n": 0})
    check("backspace", b._parse("IN: BS"), {"type": "backspace"})
    check("thumb tap asks for a page read", b._parse("EVT THUMB_TAP"), {"type": "extract"})
    check("mode switch to input", b._parse("EVT MODE INPUT"), {"type": "mode", "mode": "INPUT"})
    check("mode switch to read", b._parse("EVT MODE READ"), {"type": "mode", "mode": "READ"})

    print("\nboot and diagnostic lines pass through without breaking anything")
    for line in ("EVT READY", "EVT DRIVERS 0x3F", "EVT ERROR no driver on mux channel 4",
                 "EVT TEST dots 1 to 6 in order"):
        check(line, b._parse(line), {"type": "serial", "line": line})

    print("\nan unmapped cell is refused, and the glove is told")
    b.written[:] = []
    # 63 is all six dots, which is not a letter in basic mode.
    check("reported as unknown", b._parse("IN: 63"), {"type": "unknown", "n": 63})
    check("and PATTERN ERROR goes back to the glove", b.written, ["PATTERN ERROR"])

    print("\nhost -> firmware: the exact lines the bridge writes")
    cases = [
        ({"cmd": "CELL", "n": 25}, "CELL 25"),
        ({"cmd": "CELL", "n": 0}, "CELL 0"),
        ({"cmd": "CELL", "n": 63}, "CELL 63"),
        ({"cmd": "CLEAR"}, "CLEAR"),
        ({"cmd": "DUR", "ms": 400}, "DUR 400"),
        ({"cmd": "MODE", "mode": "READ"}, "MODE READ"),
        ({"cmd": "MODE", "mode": "INPUT"}, "MODE INPUT"),
        ({"cmd": "PATTERN", "name": "ERROR"}, "PATTERN ERROR"),
        ({"cmd": "PATTERN", "name": "MODE_READ"}, "MODE_READ"),
    ]
    for msg, expected in cases:
        b.written[:] = []
        b._handle_cmd(msg)
        want = expected if not expected.startswith("MODE_") else "PATTERN " + expected
        check("%s -> %s" % (msg.get("cmd"), want), b.written, [want])

    print("\ncell bytes are clamped to the six dot range the firmware accepts")
    b.written[:] = []
    b._handle_cmd({"cmd": "CELL", "n": 300})
    check("300 is masked to six bits", b.written, ["CELL %d" % (300 & 0x3F)])

    print("\nthe byte tables on both sides agree (context.md 3.3)")
    check("d is 25", bridge_mod.CHAR_TO_BYTE["d"], 25)
    check("y is 61", bridge_mod.CHAR_TO_BYTE["y"], 61)
    check("every letter round trips",
          all(bridge_mod.BYTE_TO_CHAR[bridge_mod.CHAR_TO_BYTE[c]] == c
              for c in "abcdefghijklmnopqrstuvwxyz"), True)

    print("\n%d passed, %d failed\n" % (passes, failures))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
