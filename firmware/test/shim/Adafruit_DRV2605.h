/* Driver shim: records the amplitude written to whichever channel the mux
   currently points at. */
#ifndef DRV_SHIM_H
#define DRV_SHIM_H
#include "Arduino.h"
#include "Wire.h"

enum { DRV2605_MODE_REALTIME = 5 };
extern uint8_t g_amplitude[8];      // per mux channel

struct Adafruit_DRV2605 {
  bool begin() { return g_muxChannel >= 0 && (g_presentMask & (1 << g_muxChannel)); }
  void selectLibrary(uint8_t) {}
  void useERM() {}
  void useLRA() {}
  void setMode(uint8_t) {}
  void setRealtimeValue(uint8_t v) {
    if (g_muxChannel >= 0 && g_muxChannel < 8) g_amplitude[g_muxChannel] = v;
  }
};
#endif
