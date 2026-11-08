/* Braille Glove - ESP32 firmware
 * MakeUC. See context.md sections 2, 6, 7 and 9.
 *
 * Output: 6 haptic motors forming one braille cell on the palm, driven by
 *         6x DRV2605L behind a PCA9548A I2C mux (they all share 0x5A).
 * Input:  5 FSRs on the fingertips; two strokes per character.
 *
 * The host (Python bridge) owns conversion and pacing. This owns the
 * motors and the whole input side, because input needs instant palm
 * feedback and a USB round trip is too slow for that.
 *
 * Serial, 115200 baud. Host -> glove:
 *     CELL <0-63>        pulse this cell for DUR ms, then stop
 *     DUR <ms>           set the pulse length
 *     CLEAR              all motors off now (interrupt)
 *     MODE <READ|INPUT>  READ ignores the finger FSRs
 *     PATTERN <name>     MODE_READ | MODE_INPUT | ERROR | CANCEL
 *     SCAN               re-probe the drivers and report
 *     TEST               fire each motor in turn, for bring-up
 *     PING               replies EVT READY
 * Glove -> host:
 *     IN: <0-63>         committed character (0 = space)
 *     IN: BS             backspace
 *     EVT THUMB_TAP      read mode: host should extract the page
 *     EVT MODE READ|INPUT
 *     EVT READY | EVT DRIVERS <mask> | EVT ERROR <text>
 *
 * NOTHING in here blocks. No delay() in the main loop: motor timing, FSR
 * sampling and serial parsing all run off millis(), or a slow pulse would
 * swallow a fingertip press.
 */

#include <Wire.h>
#include <WiFi.h>
#include <Adafruit_DRV2605.h>

/* ========================= configuration =========================
 * Everything you are likely to change while the glove is on a bench.
 */

// --- I2C ---
static const uint8_t PIN_SDA = 21;
static const uint8_t PIN_SCL = 22;
static const uint8_t MUX_ADDR = 0x70;     // PCA9548A / TCA9548A
static const uint8_t DRV_ADDR = 0x5A;     // every DRV2605L
static const uint32_t I2C_HZ = 400000;

// Set false if the motors are ERM coin type, true for LRA.
static const bool MOTOR_IS_LRA = false;

// Vibration strength, 0-127 in real-time playback mode.
static const uint8_t AMPLITUDE = 110;

/* Dot number -> mux channel. context.md 2.5 is marked "confirm physically",
 * so this is the one table to fix if letters come out scrambled: hover a
 * known letter, feel which motors fire, and reorder.
 *          dot1 dot4          ch0  ch3
 *          dot2 dot5    ->    ch1  ch4
 *          dot3 dot6          ch2  ch5                                  */
static const uint8_t DOT_TO_CHANNEL[6] = { 0, 1, 2, 3, 4, 5 };

// --- FSR pins (context.md 2.3) ---
// GPIO 25 is ADC2, which stops working if WiFi is ever switched on. We keep
// WiFi off in setup() for exactly this reason. If the thumb reads garbage,
// move it to GPIO 36 or 39.
static const uint8_t PIN_THUMB  = 25;
static const uint8_t PIN_INDEX  = 33;
static const uint8_t PIN_MIDDLE = 32;
static const uint8_t PIN_RING   = 35;
static const uint8_t PIN_PINKY  = 34;

// --- FSR tuning (context.md 6.4) ---
static const uint16_t PRESS_DELTA   = 350;  // ADC counts above baseline = pressed
static const uint16_t RELEASE_DELTA = 200;  // must fall below this to release
static const uint16_t DEBOUNCE_MS   = 25;
static const uint16_t CALIB_SAMPLES = 64;

// --- timing (context.md 4, 6.2, 6.3) ---
static const uint16_t DEFAULT_DUR_MS  = 400;   // host overrides with DUR
static const uint16_t ECHO_MS         = 220;   // palm confirmation pulses
static const uint16_t TAP_MAX_MS      = 220;   // press shorter than this = tap
static const uint16_t MULTI_TAP_MS    = 250;   // gap allowed between taps
static const uint16_t LONG_PRESS_MS   = 1000;  // pinky held = backspace
static const uint32_t CANCEL_MS       = 5000;  // half-entered letter expires

/* ========================= fingers ========================= */

enum Finger { F_THUMB = 0, F_INDEX, F_MIDDLE, F_RING, F_PINKY, F_COUNT };

static const uint8_t FSR_PIN[F_COUNT] = {
  PIN_THUMB, PIN_INDEX, PIN_MIDDLE, PIN_RING, PIN_PINKY
};

struct FingerState {
  uint16_t baseline;
  bool     down;
  uint32_t changedAt;     // last accepted edge, for debounce
  uint32_t downSince;
  bool     longFired;     // pinky: backspace already sent for this hold
};

static FingerState finger[F_COUNT];

/* ========================= haptics ========================= */

Adafruit_DRV2605 drv;
static uint8_t driversPresent = 0;        // bit per channel, from the I2C probe
static uint16_t pulseMs = DEFAULT_DUR_MS;

static void muxSelect(uint8_t ch) {
  Wire.beginTransmission(MUX_ADDR);
  Wire.write(1 << ch);
  Wire.endTransmission();
}

static void muxDisableAll() {
  Wire.beginTransmission(MUX_ADDR);
  Wire.write(0);
  Wire.endTransmission();
}

static bool driverAt(uint8_t ch) {
  muxSelect(ch);
  Wire.beginTransmission(DRV_ADDR);
  return Wire.endTransmission() == 0;
}

static void driverInit(uint8_t ch) {
  muxSelect(ch);
  drv.begin();
  drv.selectLibrary(MOTOR_IS_LRA ? 6 : 1);
  if (MOTOR_IS_LRA) drv.useLRA(); else drv.useERM();
  drv.setMode(DRV2605_MODE_REALTIME);     // amplitude in, vibration out
  drv.setRealtimeValue(0);
}

static void motorSet(uint8_t ch, uint8_t amplitude) {
  if (!(driversPresent & (1 << ch))) return;
  muxSelect(ch);
  drv.setRealtimeValue(amplitude);
}

/** Drive exactly the motors in this cell mask, and stop the others.
 *  The loop is sequential, but each pass is two I2C writes - far below
 *  what a palm can tell apart, so six dots land as one shape. */
static void applyMask(uint8_t mask) {
  for (uint8_t dot = 0; dot < 6; dot++) {
    const uint8_t ch = DOT_TO_CHANNEL[dot];
    motorSet(ch, (mask & (1 << dot)) ? AMPLITUDE : 0);
  }
}

static void allOff() {
  for (uint8_t dot = 0; dot < 6; dot++) motorSet(DOT_TO_CHANNEL[dot], 0);
}

static uint8_t probeDrivers() {
  uint8_t present = 0;
  for (uint8_t ch = 0; ch < 6; ch++) {
    if (driverAt(ch)) present |= (1 << ch);
  }
  muxDisableAll();
  return present;
}

/* ========================= pattern player =========================
 * One mechanism for everything the palm does: a plain cell is a one step
 * sequence, a mode change is two pulses, an error is three. Driven from
 * loop(), so nothing here blocks.
 */

struct Step { uint8_t mask; uint16_t onMs; uint16_t offMs; };

static const uint8_t MAX_STEPS = 6;
static Step    seq[MAX_STEPS];
static uint8_t seqLen = 0, seqIdx = 0;
static bool    seqOnPhase = false;
static uint32_t phaseUntil = 0;

static void seqStop() {
  seqLen = seqIdx = 0;
  seqOnPhase = false;
  allOff();
}

static void seqStart(const Step *steps, uint8_t n) {
  if (n > MAX_STEPS) n = MAX_STEPS;
  memcpy(seq, steps, n * sizeof(Step));
  seqLen = n;
  seqIdx = 0;
  seqOnPhase = true;
  applyMask(seq[0].mask);
  phaseUntil = millis() + seq[0].onMs;
}

static void playCell(uint8_t mask, uint16_t ms) {
  Step s = { mask, ms, 0 };
  seqStart(&s, 1);
}

static void seqTick() {
  if (!seqLen) return;
  if ((int32_t)(millis() - phaseUntil) < 0) return;

  if (seqOnPhase) {
    allOff();
    if (seq[seqIdx].offMs) {
      seqOnPhase = false;
      phaseUntil = millis() + seq[seqIdx].offMs;
      return;
    }
  }
  seqIdx++;
  if (seqIdx >= seqLen) { seqStop(); return; }
  seqOnPhase = true;
  applyMask(seq[seqIdx].mask);
  phaseUntil = millis() + seq[seqIdx].onMs;
}

static const uint8_t ALL6 = 0x3F;

// Distinct shapes so the user can tell these apart without sight (7).
static void patternModeRead()  { const Step s[] = {{ALL6,120,110},{ALL6,120,0}}; seqStart(s,2); }
static void patternModeInput() { const Step s[] = {{ALL6,250,0}};                seqStart(s,1); }
static void patternError()     { const Step s[] = {{ALL6,70,70},{ALL6,70,70},{ALL6,70,0}}; seqStart(s,3); }
static void patternCancel()    { const Step s[] = {{0x09,90,80},{0x09,90,0}};    seqStart(s,2); }

/* ========================= input state machine (9.3) ========================= */

enum Mode { MODE_READ, MODE_INPUT };
static Mode mode = MODE_READ;

enum Half { HALF_LEFT, HALF_RIGHT };
static Half half = HALF_LEFT;
static uint8_t leftLatched = 0;         // dots 1-3, already confirmed on the palm
static uint32_t lastInputActivity = 0;

// chord being built this stroke: bit0 index, bit1 middle, bit2 ring
static uint8_t chord = 0;
static bool strokeActive = false;

// thumb tap counting
static uint8_t thumbTaps = 0;
static uint32_t thumbWindowEnds = 0;

/** Put the input side back to a known state.
 *  On real hardware a reset would do this anyway, but relying on static
 *  initialisers means a soft reset is only correct by accident - and it
 *  made the host tests carry state between boots, which is how this was
 *  noticed. Explicit is better. */
static void resetInputState() {
  mode = MODE_READ;
  half = HALF_LEFT;
  leftLatched = 0;
  chord = 0;
  strokeActive = false;
  thumbTaps = 0;
  thumbWindowEnds = 0;
  pulseMs = DEFAULT_DUR_MS;
}

static void sendModeEvent() {
  Serial.print(F("EVT MODE "));
  Serial.println(mode == MODE_READ ? F("READ") : F("INPUT"));
}

static void setMode(Mode m) {
  mode = m;
  chord = 0;
  strokeActive = false;
  leftLatched = 0;
  half = HALF_LEFT;
  if (m == MODE_READ) patternModeRead(); else patternModeInput();
  sendModeEvent();
}

static void commitCell(uint8_t cell) {
  Serial.print(F("IN: "));
  Serial.println(cell);
  playCell(cell, ECHO_MS);              // echo the whole cell back (7)
  leftLatched = 0;
  half = HALF_LEFT;
}

/** A stroke finished: every index/middle/ring finger is up again. */
static void onStroke(uint8_t mask) {
  lastInputActivity = millis();
  if (!mask) return;

  if (half == HALF_LEFT) {
    leftLatched = mask & 0x07;          // dots 1-3
    half = HALF_RIGHT;
    playCell(leftLatched, ECHO_MS);     // left-column confirmation (7)
  } else {
    const uint8_t cell = leftLatched | ((mask & 0x07) << 3);
    commitCell(cell);
  }
}

static void onThumbSingle() {
  if (mode == MODE_READ) {
    Serial.println(F("EVT THUMB_TAP"));
    return;
  }
  // Input mode: commit with an empty right column (6.2). Needed for a, b, k...
  if (half == HALF_RIGHT) {
    commitCell(leftLatched);
    lastInputActivity = millis();
  }
}

static void onThumbTriple() {
  setMode(mode == MODE_READ ? MODE_INPUT : MODE_READ);
}

/* ========================= FSR reading (6.4) ========================= */

static void calibrateFsr() {
  uint32_t sum[F_COUNT] = {0};
  for (uint16_t i = 0; i < CALIB_SAMPLES; i++) {
    for (uint8_t f = 0; f < F_COUNT; f++) sum[f] += analogRead(FSR_PIN[f]);
    delay(2);                            // setup only, never in loop()
  }
  for (uint8_t f = 0; f < F_COUNT; f++) {
    finger[f].baseline = sum[f] / CALIB_SAMPLES;
    finger[f].down = false;
    finger[f].changedAt = 0;
    finger[f].downSince = 0;
    finger[f].longFired = false;
  }
}

/** Debounced, hysteretic edge detection. Returns true if the state changed. */
static bool updateFinger(uint8_t f, uint32_t now) {
  const uint16_t v = analogRead(FSR_PIN[f]);
  FingerState &s = finger[f];
  const uint16_t pressAt = s.baseline + PRESS_DELTA;
  const uint16_t releaseAt = s.baseline + RELEASE_DELTA;

  const bool want = s.down ? (v > releaseAt) : (v > pressAt);
  if (want == s.down) return false;
  if (now - s.changedAt < DEBOUNCE_MS) return false;

  s.down = want;
  s.changedAt = now;
  if (want) { s.downSince = now; s.longFired = false; }
  return true;
}

static void handleThumb(bool changed, uint32_t now) {
  FingerState &s = finger[F_THUMB];
  if (changed && !s.down) {                       // released
    const uint32_t held = now - s.downSince;
    if (held <= TAP_MAX_MS) {
      thumbTaps++;
      thumbWindowEnds = now + MULTI_TAP_MS;       // wait for a possible next tap
    }
  }
  // Classify only once the window closes with no further tap (6.2).
  if (thumbTaps && (int32_t)(now - thumbWindowEnds) >= 0) {
    if (thumbTaps >= 3) onThumbTriple();
    else if (thumbTaps == 1) onThumbSingle();
    thumbTaps = 0;
  }
}

static void handlePinky(bool changed, uint32_t now) {
  FingerState &s = finger[F_PINKY];
  if (s.down && !s.longFired && (now - s.downSince) >= LONG_PRESS_MS) {
    Serial.println(F("IN: BS"));                  // fires once per hold
    s.longFired = true;
    lastInputActivity = now;
  }
  if (changed && !s.down && !s.longFired) {
    Serial.println(F("IN: 0"));                   // short press = space
    lastInputActivity = now;
  }
}

static void handleChordFingers(bool anyChanged, uint32_t now) {
  const bool i = finger[F_INDEX].down;
  const bool m = finger[F_MIDDLE].down;
  const bool r = finger[F_RING].down;

  if (i || m || r) {
    // Latch every finger that goes down; they never land together (6.4).
    if (i) chord |= 0x01;
    if (m) chord |= 0x02;
    if (r) chord |= 0x04;
    strokeActive = true;
    lastInputActivity = now;
  } else if (strokeActive) {
    // All three released: the stroke is the union of what was pressed.
    strokeActive = false;
    const uint8_t mask = chord;
    chord = 0;
    onStroke(mask);
  }
  (void)anyChanged;
}

static void pollFsr() {
  const uint32_t now = millis();
  bool changed[F_COUNT];
  for (uint8_t f = 0; f < F_COUNT; f++) changed[f] = updateFinger(f, now);

  handleThumb(changed[F_THUMB], now);

  if (mode == MODE_INPUT) {
    handlePinky(changed[F_PINKY], now);
    handleChordFingers(changed[F_INDEX] || changed[F_MIDDLE] || changed[F_RING], now);

    // A half-entered letter expires, so the user is never silently stuck.
    if (half == HALF_RIGHT && (now - lastInputActivity) >= CANCEL_MS) {
      leftLatched = 0;
      half = HALF_LEFT;
      patternCancel();
      lastInputActivity = now;
    }
  }
  // In READ mode the finger FSRs are ignored entirely: a mouse grip would
  // otherwise register as a constant press (context.md 2.6).
}

/* ========================= serial (9.3) ========================= */

static char lineBuf[48];
static uint8_t lineLen = 0;

static void reportDrivers() {
  Serial.print(F("EVT DRIVERS 0x"));
  Serial.println(driversPresent, HEX);
  for (uint8_t ch = 0; ch < 6; ch++) {
    if (!(driversPresent & (1 << ch))) {
      Serial.print(F("EVT ERROR no driver on mux channel "));
      Serial.println(ch);
    }
  }
}

static void runMotorTest() {
  // Bring-up aid: each motor alone, in dot order, so you can confirm the
  // DOT_TO_CHANNEL table by feel.
  Step s[MAX_STEPS];
  for (uint8_t dot = 0; dot < 6; dot++) {
    s[dot].mask = (1 << dot);
    s[dot].onMs = 260;
    s[dot].offMs = 180;
  }
  seqStart(s, 6);
  Serial.println(F("EVT TEST dots 1 to 6 in order"));
}

static void handleLine(char *line) {
  if (!strncmp(line, "CELL ", 5)) {
    const int n = atoi(line + 5);
    if (n < 0 || n > 63) { Serial.println(F("EVT ERROR cell out of range")); return; }
    playCell((uint8_t)n, pulseMs);

  } else if (!strcmp(line, "CLEAR")) {
    seqStop();

  } else if (!strncmp(line, "DUR ", 4)) {
    const int ms = atoi(line + 4);
    if (ms >= 20 && ms <= 5000) pulseMs = (uint16_t)ms;

  } else if (!strncmp(line, "MODE ", 5)) {
    const Mode want = !strcmp(line + 5, "INPUT") ? MODE_INPUT : MODE_READ;
    if (want != mode) setMode(want);

  } else if (!strncmp(line, "PATTERN ", 8)) {
    const char *name = line + 8;
    if (!strcmp(name, "MODE_READ")) patternModeRead();
    else if (!strcmp(name, "MODE_INPUT")) patternModeInput();
    else if (!strcmp(name, "CANCEL")) patternCancel();
    else patternError();

  } else if (!strcmp(line, "SCAN")) {
    driversPresent = probeDrivers();
    for (uint8_t ch = 0; ch < 6; ch++) {
      if (driversPresent & (1 << ch)) driverInit(ch);
    }
    reportDrivers();

  } else if (!strcmp(line, "TEST")) {
    runMotorTest();

  } else if (!strcmp(line, "PING")) {
    Serial.println(F("EVT READY"));

  } else if (line[0]) {
    Serial.print(F("EVT ERROR unknown command "));
    Serial.println(line);
  }
}

static void pollSerial() {
  // Read whatever has arrived and return; never wait for a line to finish,
  // or the FSR loop stalls.
  while (Serial.available()) {
    const char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (lineLen) { lineBuf[lineLen] = '\0'; handleLine(lineBuf); lineLen = 0; }
    } else if (lineLen < sizeof(lineBuf) - 1) {
      lineBuf[lineLen++] = c;
    }
  }
}

/* ========================= setup / loop ========================= */

void setup() {
  Serial.begin(115200);

  // ADC2 (the thumb, GPIO 25) stops working the moment WiFi is on, and we
  // only ever talk over USB. Keep the radio off on purpose.
  WiFi.mode(WIFI_OFF);

  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);        // full ~0-3.3V swing

  resetInputState();
  seqStop();

  Wire.begin(PIN_SDA, PIN_SCL, I2C_HZ);

  driversPresent = probeDrivers();
  for (uint8_t ch = 0; ch < 6; ch++) {
    if (driversPresent & (1 << ch)) driverInit(ch);
  }
  allOff();

  calibrateFsr();                        // keep hands off the glove at boot
  lastInputActivity = millis();

  Serial.println(F("EVT READY"));
  reportDrivers();
  sendModeEvent();
}

void loop() {
  pollSerial();
  seqTick();
  pollFsr();
}
