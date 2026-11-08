#!/usr/bin/env python3
"""Braille Glove bridge.

Sits between the Chrome extension and the ESP32:

    Chrome extension  <--ws://127.0.0.1:8787-->  bridge  <--USB serial-->  ESP32

Browser -> ESP32 (JSON in, ASCII lines out), see context.md 9.3:
    {"cmd":"CELL","n":25}       -> CELL 25
    {"cmd":"CLEAR"}             -> CLEAR
    {"cmd":"DUR","ms":400}      -> DUR 400
    {"cmd":"MODE","mode":"READ"}-> MODE READ
    {"cmd":"PATTERN","name":"ERROR"} -> PATTERN ERROR

ESP32 -> browser:
    IN: <0-63>          -> {"type":"char","ch":"y","n":61}
    IN: BS              -> {"type":"backspace"}
    EVT THUMB_TAP       -> {"type":"extract"}
    EVT MODE READ|INPUT -> {"type":"mode","mode":"READ"}

Run with --mock to work with no hardware at all: cells are drawn in the
terminal as a braille cell, so the whole browser side can be demoed and
debugged before the glove is wired.

    python bridge.py --mock
    python bridge.py --port COM5
    python bridge.py --list
"""

import argparse
import asyncio
import json
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gemini as gemini_mod

try:
    import serial                     # pyserial
    import serial.tools.list_ports
except ImportError:                   # --mock does not need it
    serial = None

try:
    import websockets
except ImportError:
    print("error: pip install websockets", file=sys.stderr)
    raise SystemExit(1)


# ---------------------------------------------------------------- braille

# Letter -> dot numbers (context.md 3.3). bit0 = dot1 ... bit5 = dot6.
LETTER_DOTS = {
    "a": (1,),            "b": (1, 2),       "c": (1, 4),
    "d": (1, 4, 5),       "e": (1, 5),       "f": (1, 2, 4),
    "g": (1, 2, 4, 5),    "h": (1, 2, 5),    "i": (2, 4),
    "j": (2, 4, 5),       "k": (1, 3),       "l": (1, 2, 3),
    "m": (1, 3, 4),       "n": (1, 3, 4, 5), "o": (1, 3, 5),
    "p": (1, 2, 3, 4),    "q": (1, 2, 3, 4, 5), "r": (1, 2, 3, 5),
    "s": (2, 3, 4),       "t": (2, 3, 4, 5), "u": (1, 3, 6),
    "v": (1, 2, 3, 6),    "w": (2, 4, 5, 6), "x": (1, 3, 4, 6),
    "y": (1, 3, 4, 5, 6), "z": (1, 3, 5, 6),
}


def dots_to_byte(dots):
    n = 0
    for d in dots:
        n |= 1 << (d - 1)
    return n


CHAR_TO_BYTE = {ch: dots_to_byte(d) for ch, d in LETTER_DOTS.items()}
BYTE_TO_CHAR = {n: ch for ch, n in CHAR_TO_BYTE.items()}
BYTE_TO_CHAR[0] = " "

# Punctuation and indicators (context.md 3.5). These are display-only here:
# the glove side still just pulses a byte, and only letters map back to a
# typed character in _parse().
PUNCT_DOTS = {
    ",": (2,), ";": (2, 3), ":": (2, 5), ".": (2, 5, 6),
    "!": (2, 3, 5), "?": (2, 3, 6), "'": (3,), "-": (3, 6),
}
BYTE_LABEL = {n: ch for n, ch in ((dots_to_byte(d), c) for c, d in PUNCT_DOTS.items())}
BYTE_LABEL[dots_to_byte((6,))] = "CAP"            # capital sign, 32
BYTE_LABEL[dots_to_byte((3, 4, 5, 6))] = "NUM"    # number sign, 60
BYTE_LABEL[0] = "space"


def byte_label(n):
    """Human label for the mock printer: letter, punctuation, or indicator."""
    if n in BYTE_TO_CHAR and n != 0:
        return BYTE_TO_CHAR[n]
    return BYTE_LABEL.get(n, "?")


def cell_art(n):
    """Three-line braille cell, for the mock terminal output."""
    on = lambda d: "O" if n & (1 << (d - 1)) else "."
    return "{} {}   {} {}   {} {}".format(on(1), on(4), on(2), on(5), on(3), on(6))


# ---------------------------------------------------------------- serial

class Link:
    """Owns the serial port. Lines in from the ESP32 go to on_line()."""

    def __init__(self, port, baud, mock, on_line, typer=None):
        self.mock = mock
        self.typer = typer
        self.on_line = on_line
        self.ser = None
        self._stop = threading.Event()
        self._dur = 400

        if not mock:
            if serial is None:
                raise SystemExit("error: pip install pyserial (or run with --mock)")
            self.ser = serial.Serial(port, baud, timeout=0.2)
            time.sleep(0.4)           # ESP32 resets when the port opens
            threading.Thread(target=self._reader, daemon=True).start()
            print("[bridge] serial open on %s @ %d" % (port, baud))
        else:
            print("[bridge] MOCK mode - no serial, cells printed below")

    def write_line(self, line):
        if self.mock:
            self._mock_echo(line)
            return
        try:
            self.ser.write((line + "\n").encode("ascii", "ignore"))
        except Exception as exc:
            print("[bridge] serial write failed: %s" % exc, file=sys.stderr)

    def _mock_echo(self, line):
        if line.startswith("CELL "):
            n = int(line.split()[1])
            print("  %-6s byte %-2d  %s" % (byte_label(n), n, cell_art(n)), flush=True)
        elif line == "CLEAR":
            pass                      # too chatty to print on every interrupt
        else:
            print("[bridge] -> %s" % line, flush=True)

    def _reader(self):
        buf = b""
        while not self._stop.is_set():
            try:
                chunk = self.ser.read(128)
            except Exception as exc:
                print("[bridge] serial read failed: %s" % exc, file=sys.stderr)
                return
            if not chunk:
                continue
            buf += chunk
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                line = raw.decode("utf-8", "replace").strip()
                if line:
                    self.on_line(line)

    def close(self):
        self._stop.set()
        if self.ser:
            try:
                self.ser.close()
            except Exception:
                pass


# ---------------------------------------------------------------- typing

class Typer:
    """Optional: type committed letters into whatever window has focus (9.2a)."""

    def __init__(self):
        from pynput.keyboard import Controller, Key
        self.kb = Controller()
        self.Key = Key

    def char(self, ch):
        self.kb.type(ch)

    def backspace(self):
        self.kb.press(self.Key.backspace)
        self.kb.release(self.Key.backspace)


# ---------------------------------------------------------------- server

class Bridge:
    def __init__(self, link_args, typer, gem=None):
        self.clients = set()
        self.loop = None
        self.typer = typer
        self.gemini = gem
        self.link = Link(on_line=self._on_serial_line, typer=typer, **link_args)

    # --- serial -> browser (runs on the reader thread) ---

    def _on_serial_line(self, line):
        print("[esp32] %s" % line, flush=True)
        msg = self._parse(line)
        if msg and self.loop:
            asyncio.run_coroutine_threadsafe(self._broadcast(msg), self.loop)

    def _parse(self, line):
        if line.startswith("IN:"):
            arg = line[3:].strip()
            if arg.upper() == "BS":
                if self.typer:
                    self.typer.backspace()
                return {"type": "backspace"}
            try:
                n = int(arg) & 0x3F
            except ValueError:
                return {"type": "serial", "line": line}
            ch = BYTE_TO_CHAR.get(n)
            if ch is None:
                # Unmapped cell: tell the glove, type nothing (9.2a step 4).
                self.link.write_line("PATTERN ERROR")
                return {"type": "unknown", "n": n}
            if self.typer:
                self.typer.char(ch)
            return {"type": "char", "ch": ch, "n": n}

        if line.startswith("EVT"):
            parts = line.split()
            if len(parts) >= 2 and parts[1] == "THUMB_TAP":
                return {"type": "extract"}
            if len(parts) >= 3 and parts[1] == "MODE":
                return {"type": "mode", "mode": parts[2]}

        return {"type": "serial", "line": line}

    async def _broadcast(self, msg):
        if not self.clients:
            return
        data = json.dumps(msg)
        dead = []
        for ws in self.clients:
            try:
                await ws.send(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    # --- browser -> serial ---

    def _handle_cmd(self, msg):
        cmd = str(msg.get("cmd", "")).upper()
        if cmd == "CELL":
            n = int(msg.get("n", 0)) & 0x3F
            self.link.write_line("CELL %d" % n)
        elif cmd == "CLEAR":
            self.link.write_line("CLEAR")
        elif cmd == "DUR":
            self.link.write_line("DUR %d" % int(msg.get("ms", 400)))
        elif cmd == "MODE":
            mode = str(msg.get("mode", "READ")).upper()
            self.link.write_line("MODE %s" % ("INPUT" if mode == "INPUT" else "READ"))
        elif cmd == "PATTERN":
            self.link.write_line("PATTERN %s" % msg.get("name", "ERROR"))
        elif cmd == "TEXT":
            # Convenience: let a client hand over a whole string. Pacing still
            # belongs to the browser, so this only logs the cell sequence.
            for ch in str(msg.get("text", "")).lower():
                n = CHAR_TO_BYTE.get(ch, 0 if ch == " " else None)
                if n is not None:
                    self.link.write_line("CELL %d" % n)
        elif cmd == "SUMMARIZE":
            return False          # handled asynchronously, see serve()
        else:
            print("[bridge] unknown cmd: %r" % msg, file=sys.stderr)
        return True

    # --- Gemini (context.md 8.2 / 8.3) ---

    async def _summarize(self, ws, msg):
        """Summarize page text for the glove and answer the client.

        Always replies, even on failure: the extension is waiting on this id
        before it plays anything.
        """
        req_id = msg.get("id")
        text = str(msg.get("text", ""))
        title = str(msg.get("title", ""))
        max_chars = int(msg.get("maxChars", 140))

        if self.gemini is None:
            summary = gemini_mod.fallback_text(text, max_chars)
            source, ms = "fallback", 0
        else:
            # The blocking HTTP call runs off the event loop so cells keep
            # flowing while we wait.
            summary, source, ms = await asyncio.to_thread(
                self.gemini.summarize, text, title, max_chars)

        reason = getattr(self.gemini, "last_reason", "") if self.gemini else "no api key"
        print("[gemini] %s in %dms%s: %s"
              % (source, ms, " (%s)" % reason if reason else "", summary or "(empty)"),
              flush=True)
        try:
            await ws.send(json.dumps({
                "type": "summary", "id": req_id, "text": summary,
                "source": source, "ms": ms, "inChars": len(text),
                "reason": reason,
            }))
        except Exception:
            pass

    async def serve(self, ws):
        self.clients.add(ws)
        peer = getattr(ws, "remote_address", ("?",))[0]
        print("[bridge] extension connected (%s), %d client(s)"
              % (peer, len(self.clients)), flush=True)
        try:
            await ws.send(json.dumps({
                "type": "hello",
                "mock": self.link.mock,
                "gemini": bool(self.gemini and self.gemini.enabled),
                "model": self.gemini.model if self.gemini else None,
            }))
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                if str(msg.get("cmd", "")).upper() == "SUMMARIZE":
                    # Fire and forget: a slow summary must not stall CELL/CLEAR.
                    asyncio.create_task(self._summarize(ws, msg))
                else:
                    self._handle_cmd(msg)
        except Exception:
            pass
        finally:
            self.clients.discard(ws)
            print("[bridge] extension disconnected, %d client(s)"
                  % len(self.clients), flush=True)


# ---------------------------------------------------------------- main

def pick_port():
    ports = list(serial.tools.list_ports.comports()) if serial else []
    for p in ports:
        blob = "%s %s" % (p.description or "", p.manufacturer or "")
        if any(k in blob for k in ("CP210", "CH340", "Silicon Labs", "USB Serial", "wchusb")):
            return p.device
    return ports[0].device if ports else None


def list_ports():
    if serial is None:
        print("pyserial is not installed")
        return
    ports = list(serial.tools.list_ports.comports())
    if not ports:
        print("no serial ports found")
    for p in ports:
        print("  %-12s %s" % (p.device, p.description))


async def amain(args):
    link_args = {"port": args.port, "baud": args.baud, "mock": args.mock}

    typer = None
    if args.type_keys:
        try:
            typer = Typer()
            print("[bridge] typing committed letters into the focused window")
        except Exception as exc:
            print("[bridge] typing disabled (%s)" % exc, file=sys.stderr)

    gem = gemini_mod.Gemini(model=args.model, timeout=args.gemini_timeout)
    if gem.enabled:
        print("[bridge] Gemini on, model %s, %.1fs timeout"
              % (gem.model, args.gemini_timeout))
    else:
        print("[bridge] Gemini off (set GEMINI_API_KEY to enable); "
              "extract will read the page text itself")

    bridge = Bridge(link_args, typer, gem)
    bridge.loop = asyncio.get_running_loop()

    # An older bridge left running on the default port used to be an
    # afternoon of confusion: the extension connected to it happily and
    # simply never summarized. Take the next free port instead and say so;
    # the extension probes the range and finds us.
    server = None
    for port in range(args.port_ws, args.port_ws + 10):
        try:
            server = await websockets.serve(bridge.serve, args.host, port)
        except OSError:
            print("[bridge] port %d is busy, trying %d" % (port, port + 1), flush=True)
            continue
        if port != args.port_ws:
            print("[bridge] NOTE: %d was taken - something else is still running there"
                  % args.port_ws, flush=True)
        break

    if server is None:
        print("[bridge] no free port in %d-%d" % (args.port_ws, args.port_ws + 9),
              file=sys.stderr)
        raise SystemExit(2)

    async with server:
        print("[bridge] listening on ws://%s:%d" % (args.host, port), flush=True)
        print("[bridge] load the extension, then hover the demo page", flush=True)
        try:
            await asyncio.Future()
        finally:
            bridge.link.close()


def main():
    ap = argparse.ArgumentParser(description="Braille Glove serial/WebSocket bridge")
    ap.add_argument("--port", help="serial port, e.g. COM5 or /dev/ttyUSB0 (auto-detected if omitted)")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port-ws", type=int, default=8787, dest="port_ws")
    ap.add_argument("--mock", action="store_true", help="no hardware; print cells to the terminal")
    ap.add_argument("--type-keys", action="store_true", dest="type_keys",
                    help="type committed letters into the focused window (needs pynput)")
    ap.add_argument("--list", action="store_true", help="list serial ports and exit")
    ap.add_argument("--model", default=None,
                    help="Gemini model id (default %s, or $GEMINI_MODEL)"
                         % gemini_mod.DEFAULT_MODEL)
    ap.add_argument("--gemini-timeout", type=float, default=5.0, dest="gemini_timeout",
                    help="seconds before falling back to the raw page text (default 5)")
    ap.add_argument("--list-models", action="store_true", dest="list_models",
                    help="ask Gemini which models this key can use, and exit")
    ap.add_argument("--summarize", metavar="FILE",
                    help="summarize a text file and exit; use - for stdin")
    args = ap.parse_args()

    if args.list:
        list_ports()
        return

    if args.list_models:
        gem = gemini_mod.Gemini(model=args.model)
        if not gem.enabled:
            print("GEMINI_API_KEY is not set")
            return
        try:
            for name in gem.list_models():
                print("  " + name)
        except Exception as exc:
            print("could not list models: %s" % exc, file=sys.stderr)
        return

    if args.summarize:
        text = (sys.stdin.read() if args.summarize == "-"
                else open(args.summarize, encoding="utf-8", errors="replace").read())
        gem = gemini_mod.Gemini(model=args.model, timeout=args.gemini_timeout)
        summary, source, ms = gem.summarize(text, max_chars=140)
        print("\nsource : %s (%dms)\nin     : %d chars\nout    : %d chars\n\n%s\n"
              % (source, ms, len(text), len(summary), summary))
        return

    if not args.mock and not args.port:
        args.port = pick_port()
        if not args.port:
            print("no serial port found. Plug in the ESP32, or run with --mock.",
                  file=sys.stderr)
            raise SystemExit(2)
        print("[bridge] auto-detected %s" % args.port)

    try:
        asyncio.run(amain(args))
    except KeyboardInterrupt:
        print("\n[bridge] bye")


if __name__ == "__main__":
    main()
