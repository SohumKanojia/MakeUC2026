/* I2C shim: tracks which mux channel is selected and what amplitude each
 * DRV2605 was last told to play, so tests can assert on the motors. */
#ifndef WIRE_SHIM_H
#define WIRE_SHIM_H
#include "Arduino.h"

extern int  g_muxChannel;        // -1 = none selected
extern uint8_t g_presentMask;    // which channels have a driver on the bench

struct WireShim {
  uint8_t addr = 0;
  void begin(int, int, uint32_t) {}
  void beginTransmission(uint8_t a) { addr = a; }
  void write(uint8_t v) {
    if (addr == 0x70) {                       // mux select register
      g_muxChannel = -1;
      for (int ch = 0; ch < 8; ch++) if (v & (1 << ch)) { g_muxChannel = ch; break; }
    }
  }
  uint8_t endTransmission() {
    if (addr == 0x5A) {                       // is a driver answering here?
      if (g_muxChannel < 0) return 2;
      return (g_presentMask & (1 << g_muxChannel)) ? 0 : 2;
    }
    return 0;
  }
};
extern WireShim Wire;
#endif
