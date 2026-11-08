"""Exercises the Gemini client against a stub server, so the HTTP path,
the 404 model repair, the timeout fallback and the sanitizer are all
tested without a real API key.

    python bridge/test_gemini.py
"""

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gemini as g

PAGE = ("The city transit authority opened a new light rail line on Tuesday, "
        "the first in the network built to be step free along its entire length. "
        "Tactile paving runs the full length of each platform.")

seen = {"requests": [], "bodies": []}


class Stub(BaseHTTPRequestHandler):
    """Pretends to be generativelanguage.googleapis.com."""
    answer = "step free light rail line opens with tactile paving on every platform"
    # Model ids this fake API will serve. "made-up-model" is not one of
    # them, which is what drives the repair path.
    known_models = ("gemini-flash-latest", "gemini-2.5-flash")
    delay = 0.0

    def log_message(self, *a):
        pass

    def handle_one_request(self):
        # The timeout test hangs up mid-response on purpose; that is the
        # behaviour under test, not an error worth printing.
        try:
            BaseHTTPRequestHandler.handle_one_request(self)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            self.close_connection = True

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        seen["requests"].append(("GET", self.path))
        if self.path.startswith("/v1beta/models"):
            self._send(200, {"models": [
                {"name": "models/gemini-embedding-001",
                 "supportedGenerationMethods": ["embedContent"]},
                {"name": "models/gemini-2.5-flash",
                 "supportedGenerationMethods": ["generateContent"]},
                {"name": "models/gemini-2.5-pro",
                 "supportedGenerationMethods": ["generateContent"]},
            ]})
        else:
            self._send(404, {"error": "nope"})

    def do_POST(self):
        seen["requests"].append(("POST", self.path))
        n = int(self.headers.get("Content-Length", 0))
        seen["bodies"].append(json.loads(self.rfile.read(n) or b"{}"))

        if not any(m in self.path for m in Stub.known_models):
            self._send(404, {"error": {"message": "model not found"}})
            return
        if Stub.delay:
            time.sleep(Stub.delay)
        self._send(200, {"candidates": [
            {"content": {"parts": [{"text": Stub.answer}]}}
        ]})


class QuietServer(HTTPServer):
    def handle_error(self, request, client_address):
        pass


def serve():
    srv = QuietServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


pass_n = fail_n = 0


def check(label, got, want):
    global pass_n, fail_n
    if got == want:
        pass_n += 1
        print("  ok   " + label)
    else:
        fail_n += 1
        print("  FAIL %s\n         got  %r\n         want %r" % (label, got, want))


def main():
    global pass_n, fail_n
    srv = serve()
    g.API_HOST = "http://127.0.0.1:%d" % srv.server_address[1]

    print("\nhappy path")
    gem = g.Gemini(api_key="test-key", model="gemini-flash-latest", timeout=3.0, log=lambda *a: None)
    text, source, ms = gem.summarize(PAGE, title="Transit", max_chars=140)
    check("source is gemini", source, "gemini")
    check("answer came through", text, Stub.answer)
    check("within the character budget", len(text) <= 140, True)

    body = seen["bodies"][-1]
    check("system instruction is sent", "systemInstruction" in body, True)
    check("max_chars reached the prompt",
          "140 characters" in body["systemInstruction"]["parts"][0]["text"], True)

    sys_text = body["systemInstruction"]["parts"][0]["text"].lower()
    check("prompt forbids invented qualifiers", "no added qualifiers" in sys_text, True)
    check("prompt names the observed failures",
          all(w in sys_text for w in ("real time", "fully", "seamless")), True)
    check("prompt demands faithfulness first", "faithfulness" in sys_text, True)
    check("temperature is zero", body["generationConfig"]["temperature"], 0.0)
    check("page title is included",
          "TITLE: Transit" in body["contents"][0]["parts"][0]["text"], True)
    check("page text is included",
          "light rail" in body["contents"][0]["parts"][0]["text"], True)

    print("\ncache: repeats cost no quota")
    seen["requests"].clear()
    gem = g.Gemini(api_key="test-key", model="gemini-flash-latest", timeout=3.0, log=lambda *a: None)
    Stub.answer = "step free light rail line opens with tactile paving"
    posts = lambda: len([1 for m, _ in seen["requests"] if m == "POST"])

    first_text, _, _ = gem.summarize(PAGE, title="Transit", max_chars=140)
    check("first call hits the API", posts(), 1)
    second_text, second_src, second_ms = gem.summarize(PAGE, title="Transit", max_chars=140)
    check("repeat makes no second request", posts(), 1)
    check("repeat returns the same text", second_text, first_text)
    check("repeat still reports gemini", second_src, "gemini")
    check("repeat is instant", second_ms, 0)
    check("repeat is marked cached", gem.last_reason, "cached")

    gem.summarize(PAGE, title="Transit", max_chars=60)
    check("a different length is a different request", posts(), 2)
    gem.summarize(PAGE + " One extra sentence.", title="Transit", max_chars=140)
    check("different text is a different request", posts(), 3)

    # A fallback must never be cached, or one blip would poison that page
    # for the rest of the session.
    seen["requests"].clear()
    gem2 = g.Gemini(api_key="test-key", model="gemini-flash-latest", timeout=3.0, log=lambda *a: None)
    Stub.answer = "   "                      # unusable -> fallback
    gem2.summarize(PAGE, max_chars=140)
    Stub.answer = "a real answer this time"
    text3, src3, _ = gem2.summarize(PAGE, max_chars=140)
    check("a fallback is not cached", src3, "gemini")
    check("the retry gets the real answer", text3, "a real answer this time")
    Stub.answer = "step free light rail line opens with tactile paving on every platform"

    print("\nmodel repair on 404")
    seen["requests"].clear()
    gem = g.Gemini(api_key="test-key", model="made-up-model", timeout=3.0, log=lambda *a: None)
    text, source, _ = gem.summarize(PAGE, max_chars=140)
    check("still answered", source, "gemini")
    check("asked the API for its model list",
          any(m == "GET" and "/v1beta/models" in p for m, p in seen["requests"]), True)
    check("switched to a flash model", gem.model, "gemini-2.5-flash")

    print("\ntimeout falls back to the page")
    Stub.delay = 1.5
    gem = g.Gemini(api_key="test-key", model="gemini-flash-latest", timeout=0.3, log=lambda *a: None)
    text, source, ms = gem.summarize(PAGE, max_chars=140)
    check("source is fallback", source, "fallback")
    check("fallback is the head of the page", text.startswith("the city transit authority"), True)
    # The point is that it did not wait for the stub's 1.5s reply,
    # not an exact figure - a tighter bound is flaky under load.
    check("gave up before the server answered", ms < 1500, True)
    Stub.delay = 0.0

    print("\nno key at all")
    gem = g.Gemini(api_key="", log=lambda *a: None)
    text, source, _ = gem.summarize(PAGE, max_chars=60)
    check("source is fallback", source, "fallback")
    check("respects max_chars", len(text) <= 60, True)

    print("\nmodel ignores the format rules")
    Stub.answer = "**The Transit Line** opened Tuesday with 12 stops! (see details)"
    gem = g.Gemini(api_key="test-key", model="gemini-flash-latest", log=lambda *a: None)
    text, source, _ = gem.summarize(PAGE, max_chars=140)
    check("sanitized to a-z and spaces", text,
          "the transit line opened tuesday with stops see details")
    check("no markdown survives", "*" in text, False)

    print("\nempty candidate falls back")
    Stub.answer = "   "
    gem = g.Gemini(api_key="test-key", model="gemini-flash-latest", log=lambda *a: None)
    text, source, _ = gem.summarize(PAGE, max_chars=140)
    check("source is fallback", source, "fallback")

    print("\nserver is unreachable")
    g.API_HOST = "http://127.0.0.1:1"
    gem = g.Gemini(api_key="test-key", timeout=1.0, log=lambda *a: None)
    text, source, _ = gem.summarize(PAGE, max_chars=140)
    check("source is fallback", source, "fallback")
    check("never raises, always returns text", bool(text), True)

    print("\n%d passed, %d failed\n" % (pass_n, fail_n))
    return 1 if fail_n else 0


if __name__ == "__main__":
    sys.exit(main())
