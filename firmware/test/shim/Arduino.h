/* Minimal Arduino shim so the firmware can be compiled and exercised on a
 * laptop with g++. It models only what braille_glove.ino actually touches:
 * a virtual clock, the ADC pins, and a Serial that records its output.
 *
 * This is a test double, not an emulator. It proves the logic - stroke
 * detection, tap classification, the state machine, command parsing - and
 * says nothing about real I2C timing or how a motor feels.
 */
#ifndef ARDUINO_SHIM_H
#define ARDUINO_SHIM_H

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <string>
#include <vector>
#include <map>

#define F(x) (x)
#define HEX 16
#define DEC 10

typedef uint8_t byte;

/* ---- virtual clock: tests move time themselves ---- */
extern uint32_t g_millis;
inline uint32_t millis() { return g_millis; }
inline void delay(uint32_t ms) { g_millis += ms; }

/* ---- ADC ---- */
extern std::map<uint8_t, uint16_t> g_adc;      // pin -> raw value
inline int analogRead(uint8_t pin) {
  auto it = g_adc.find(pin);
  return it == g_adc.end() ? 0 : it->second;
}
inline void analogReadResolution(int) {}
enum { ADC_11db = 3 };
inline void analogSetAttenuation(int) {}

/* ---- Serial: every line the firmware emits is kept for assertions ---- */
struct SerialShim {
  std::vector<std::string> lines;     // completed lines
  std::string partial;
  std::string inbox;                  // bytes waiting to be read

  void begin(unsigned long) {}
  int available() { return (int)inbox.size(); }
  int read() {
    if (inbox.empty()) return -1;
    char c = inbox[0];
    inbox.erase(inbox.begin());
    return (unsigned char)c;
  }
  void feed(const std::string &s) { inbox += s; }

  void print(const char *s) { partial += s; }
  void print(const std::string &s) { partial += s; }
  void print(int v, int base = DEC) {
    char buf[32];
    if (base == HEX) snprintf(buf, sizeof buf, "%X", v);
    else snprintf(buf, sizeof buf, "%d", v);
    partial += buf;
  }
  void print(unsigned v, int base = DEC) { print((int)v, base); }
  void println() { lines.push_back(partial); partial.clear(); }
  void println(const char *s) { print(s); println(); }
  void println(const std::string &s) { print(s); println(); }
  void println(int v, int base = DEC) { print(v, base); println(); }
  void println(unsigned v, int base = DEC) { print((int)v, base); println(); }

  void clear() { lines.clear(); partial.clear(); }
  bool saw(const std::string &needle) const {
    for (const auto &l : lines) if (l.find(needle) != std::string::npos) return true;
    return false;
  }
  int count(const std::string &needle) const {
    int n = 0;
    for (const auto &l : lines) if (l.find(needle) != std::string::npos) n++;
    return n;
  }
  std::string last() const { return lines.empty() ? "" : lines.back(); }
};
extern SerialShim Serial;

#endif
