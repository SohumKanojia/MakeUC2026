/* Host tests for braille_glove.ino.
 *
 *   g++ -std=c++17 -I shim test_firmware.cpp -o test_firmware && ./test_firmware
 *
 * The real firmware source is compiled in, unmodified. Only the Arduino
 * layer is a double: a virtual clock, fake ADC pins and a recording Serial.
 * That covers everything that is easy to get wrong and impossible to see on
 * a bench - tap classification, stroke latching, the cancel timer, command
 * parsing - and nothing about real I2C timing or how a motor feels.
 */
#include "shim/Arduino.h"
#include "shim/Wire.h"
#include "shim/WiFi.h"
#include "shim/Adafruit_DRV2605.h"

uint32_t g_millis = 0;
std::map<uint8_t, uint16_t> g_adc;
SerialShim Serial;
WireShim Wire;
WiFiShim WiFi;
int g_muxChannel = -1;
uint8_t g_presentMask = 0x3F;          // all six drivers fitted
uint8_t g_amplitude[8] = {0};

#include "../braille_glove/braille_glove.ino"

/* ------------------------------------------------------------------ */

static int passes = 0, failures = 0;

static void check(const std::string &label, bool ok, const std::string &detail = "") {
  if (ok) { passes++; printf("  ok   %s\n", label.c_str()); }
  else { failures++; printf("  FAIL %s%s%s\n", label.c_str(),
                            detail.empty() ? "" : "  -> ", detail.c_str()); }
}

template <typename T>
static void eq(const std::string &label, T got, T want) {
  if (got == want) { passes++; printf("  ok   %s\n", label.c_str()); }
  else {
    failures++;
    std::string g = std::to_string(got), w = std::to_string(want);
    printf("  FAIL %s  got %s want %s\n", label.c_str(), g.c_str(), w.c_str());
  }
}

/* ---- helpers that drive the glove the way fingers would ---- */

static const uint16_t REST = 300;      // quiet ADC level
static const uint16_t PRESSED = 300 + PRESS_DELTA + 120;

static void advance(uint32_t ms) {     // run the firmware for this long
  for (uint32_t i = 0; i < ms; i++) { g_millis++; loop(); }
}

static void setFinger(uint8_t pin, bool down) { g_adc[pin] = down ? PRESSED : REST; }

static void tap(uint8_t pin, uint32_t holdMs = 60, uint32_t gapMs = 60) {
  setFinger(pin, true);  advance(holdMs);
  setFinger(pin, false); advance(gapMs);
}

/** One braille stroke: press a chord, release it, let the stroke close. */
static void stroke(bool index, bool middle, bool ring) {
  if (index)  setFinger(PIN_INDEX, true);
  advance(40);
  if (middle) setFinger(PIN_MIDDLE, true);
  advance(40);
  if (ring)   setFinger(PIN_RING, true);
  advance(60);
  setFinger(PIN_INDEX, false);
  setFinger(PIN_MIDDLE, false);
  setFinger(PIN_RING, false);
  advance(60);
}

static void send(const std::string &cmd) { Serial.feed(cmd + "\n"); advance(2); }

static uint8_t activeMask() {          // which dots are vibrating right now
  uint8_t m = 0;
  for (uint8_t dot = 0; dot < 6; dot++)
    if (g_amplitude[DOT_TO_CHANNEL[dot]] > 0) m |= (1 << dot);
  return m;
}

static void boot() {
  g_millis = 0;
  Serial.clear();
  for (uint8_t f = 0; f < F_COUNT; f++) g_adc[FSR_PIN[f]] = REST;
  memset(g_amplitude, 0, sizeof g_amplitude);
  setup();
}

static void toInputMode() {
  Serial.clear();
  tap(PIN_THUMB); tap(PIN_THUMB); tap(PIN_THUMB);
  advance(MULTI_TAP_MS + 60);
  advance(600);                        // let the mode pattern finish
}

/* ------------------------------------------------------------------ */

int main() {
  printf("\nboot\n");
  boot();
  check("announces itself", Serial.saw("EVT READY"));
  check("reports the drivers it found", Serial.saw("EVT DRIVERS 0x3F"));
  check("starts in read mode", Serial.saw("EVT MODE READ"));
  check("no spurious driver errors", !Serial.saw("EVT ERROR"));
  eq<int>("motors silent at boot", activeMask(), 0);
  check("wifi is off, so ADC2 keeps working", WiFi.mode_ == WIFI_OFF);

  printf("\nmissing hardware is reported, not ignored\n");
  g_presentMask = 0x0F;                // channels 4 and 5 unpopulated
  boot();
  check("flags the missing channels", Serial.count("EVT ERROR no driver") == 2);
  g_presentMask = 0x3F;

  printf("\nCELL drives the right motors (d = dots 1,4,5 = 25)\n");
  boot();
  send("DUR 300");
  send("CELL 25");
  advance(5);
  eq<int>("dots 1, 4 and 5 fire together", activeMask(), 25);
  advance(200);
  eq<int>("still on before DUR elapses", activeMask(), 25);
  advance(150);
  eq<int>("all off after DUR", activeMask(), 0);

  printf("\nCLEAR interrupts at once\n");
  send("CELL 63");
  advance(20);
  eq<int>("all six on", activeMask(), 63);
  send("CLEAR");
  eq<int>("silent immediately", activeMask(), 0);

  printf("\nbad input is refused, not obeyed\n");
  Serial.clear();
  send("CELL 99");
  check("out of range cell rejected", Serial.saw("EVT ERROR cell out of range"));
  eq<int>("and nothing vibrates", activeMask(), 0);
  Serial.clear();
  send("WOBBLE");
  check("unknown command reported", Serial.saw("EVT ERROR unknown command WOBBLE"));

  printf("\nread mode: thumb tap asks the host to read the page\n");
  boot();
  Serial.clear();
  tap(PIN_THUMB);
  advance(MULTI_TAP_MS + 60);
  check("single tap sends THUMB_TAP", Serial.saw("EVT THUMB_TAP"));
  eq<int>("exactly one", Serial.count("EVT THUMB_TAP"), 1);

  printf("\nread mode ignores the finger FSRs (a mouse grip must not type)\n");
  Serial.clear();
  stroke(true, false, true);
  stroke(true, true, true);
  tap(PIN_PINKY);
  advance(100);
  check("no characters produced", !Serial.saw("IN:"));

  printf("\ntriple tap toggles the mode, both ways\n");
  boot();
  Serial.clear();
  tap(PIN_THUMB); tap(PIN_THUMB); tap(PIN_THUMB);
  advance(MULTI_TAP_MS + 60);
  check("switched to input", Serial.saw("EVT MODE INPUT"));
  advance(600);
  Serial.clear();
  tap(PIN_THUMB); tap(PIN_THUMB); tap(PIN_THUMB);
  advance(MULTI_TAP_MS + 60);
  check("switched back to read", Serial.saw("EVT MODE READ"));

  printf("\ntyping y = dots 1,3 then 4,5,6 = 61 (context.md 6.3)\n");
  boot();
  toInputMode();
  Serial.clear();
  stroke(true, false, true);                  // left column: dots 1 and 3
  advance(5);
  eq<int>("palm replays the left column", activeMask(), 0x05);
  advance(ECHO_MS + 20);
  check("nothing committed yet", !Serial.saw("IN:"));
  stroke(true, true, true);                   // right column: dots 4, 5, 6
  advance(5);
  check("commits y as 61", Serial.saw("IN: 61"));
  eq<int>("palm echoes the whole cell", activeMask(), 61);

  printf("\ntyping a = dots 1 then a thumb tap (empty right column)\n");
  boot();
  toInputMode();
  Serial.clear();
  stroke(true, false, false);
  advance(ECHO_MS + 40);
  tap(PIN_THUMB);
  advance(MULTI_TAP_MS + 60);
  check("commits a as 1", Serial.saw("IN: 1"));

  printf("\nthumb with nothing latched does nothing\n");
  boot();
  toInputMode();
  Serial.clear();
  tap(PIN_THUMB);
  advance(MULTI_TAP_MS + 60);
  check("no character", !Serial.saw("IN:"));
  check("and no page-read event in input mode", !Serial.saw("EVT THUMB_TAP"));

  printf("\npinky: tap is space, long press is backspace\n");
  boot();
  toInputMode();
  Serial.clear();
  tap(PIN_PINKY);
  advance(20);
  check("tap sends a space", Serial.saw("IN: 0"));
  Serial.clear();
  setFinger(PIN_PINKY, true);
  advance(LONG_PRESS_MS + 60);
  check("hold sends backspace", Serial.saw("IN: BS"));
  eq<int>("exactly once while held", Serial.count("IN: BS"), 1);
  advance(1500);
  eq<int>("still once after holding longer", Serial.count("IN: BS"), 1);
  setFinger(PIN_PINKY, false);
  advance(80);
  eq<int>("release does not also send a space", Serial.count("IN: 0"), 0);

  printf("\na half-entered letter expires after 5s\n");
  boot();
  toInputMode();
  Serial.clear();
  stroke(true, false, true);                  // latch the left column
  advance(ECHO_MS + 40);
  advance(CANCEL_MS - 500);
  check("still waiting just before the timeout", !Serial.saw("IN:"));
  advance(900);
  stroke(false, true, false);                 // a fresh first stroke
  advance(5);
  eq<int>("treated as a new left column, not a commit", activeMask(), 0x02);
  check("nothing was committed", !Serial.saw("IN:"));

  printf("\nchord latching: fingers never land together\n");
  boot();
  toInputMode();
  Serial.clear();
  setFinger(PIN_INDEX, true);   advance(50);
  setFinger(PIN_RING, true);    advance(50);
  setFinger(PIN_INDEX, false);  advance(50);  // one lifts early
  check("no stroke while any finger is still down", !Serial.saw("IN:"));
  eq<int>("palm has not replayed anything yet", activeMask(), 0);
  setFinger(PIN_RING, false);   advance(50);
  eq<int>("stroke is the union of both", activeMask(), 0x05);

  printf("\ndebounce rejects a contact bounce\n");
  boot();
  toInputMode();
  Serial.clear();
  setFinger(PIN_INDEX, true);  advance(5);
  setFinger(PIN_INDEX, false); advance(5);    // bounce, well under DEBOUNCE_MS
  setFinger(PIN_INDEX, true);  advance(80);
  setFinger(PIN_INDEX, false); advance(80);
  eq<int>("one clean stroke, dot 1", activeMask(), 0x01);

  printf("\nhysteresis: a press hovering at the threshold does not chatter\n");
  boot();
  toInputMode();
  Serial.clear();
  g_adc[PIN_INDEX] = REST + PRESS_DELTA + 20;   // just over the press line
  advance(60);
  g_adc[PIN_INDEX] = REST + PRESS_DELTA - 60;   // dips, but above release
  advance(60);
  check("still held", !Serial.saw("IN:"));
  g_adc[PIN_INDEX] = REST;                      // now properly released
  advance(60);
  eq<int>("released once, as dot 1", activeMask(), 0x01);

  printf("\nMODE from the host matches the glove's own switching\n");
  boot();
  Serial.clear();
  send("MODE INPUT");
  advance(600);
  check("host can put it in input mode", Serial.saw("EVT MODE INPUT"));
  Serial.clear();
  send("MODE INPUT");
  check("repeating it is a no-op", !Serial.saw("EVT MODE"));

  printf("\nPATTERN and TEST\n");
  boot();
  Serial.clear();
  send("PATTERN ERROR");
  advance(5);
  eq<int>("error pattern uses all six", activeMask(), 63);
  send("CLEAR");
  send("TEST");
  advance(5);
  eq<int>("motor test starts at dot 1 alone", activeMask(), 0x01);
  advance(260 + 180);
  eq<int>("then dot 2 alone", activeMask(), 0x02);
  Serial.clear();
  send("PING");
  check("PING answers", Serial.saw("EVT READY"));

  printf("\nserial parsing never blocks the finger loop\n");
  boot();
  toInputMode();
  Serial.clear();
  Serial.feed("CEL");                   // a command arrives in pieces
  advance(30);
  stroke(true, false, false);           // fingers keep working meanwhile
  advance(5);
  eq<int>("stroke still registered mid-command", activeMask(), 0x01);
  Serial.feed("L 63\n");
  advance(ECHO_MS + 30);
  advance(5);
  eq<int>("and the split command still runs", activeMask(), 63);

  printf("\nevery command the bridge writes is understood\n");
  // These strings are copied from bridge.py's write_line calls. The matching
  // half is bridge/test_protocol.py, which checks the other direction.
  boot();
  const char *fromBridge[] = {
    "CELL 0", "CELL 25", "CELL 61", "CELL 63",
    "CLEAR", "DUR 400", "DUR 600",
    "MODE READ", "MODE INPUT",
    "PATTERN ERROR", "PATTERN MODE_READ", "PATTERN MODE_INPUT",
  };
  for (const char *cmd : fromBridge) {
    Serial.clear();
    send(cmd);
    send("CLEAR");
    check(std::string("accepts ") + cmd, !Serial.saw("EVT ERROR unknown command"));
  }

  printf("\nline endings from the host do not matter\n");
  boot();
  Serial.clear();
  Serial.feed("CELL 25\r\n");           // CRLF, as some terminals send
  advance(5);
  eq<int>("CRLF accepted", activeMask(), 25);
  check("no error raised", !Serial.saw("EVT ERROR"));
  send("CLEAR");
  Serial.feed("\n\n");                  // stray blank lines
  advance(5);
  check("blank lines ignored", !Serial.saw("EVT ERROR"));

  printf("\n%d passed, %d failed\n\n", passes, failures);
  return failures ? 1 : 0;
}
