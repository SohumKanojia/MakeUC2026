#ifndef WIFI_SHIM_H
#define WIFI_SHIM_H
enum { WIFI_OFF = 0 };
struct WiFiShim { int mode_ = -1; void mode(int m) { mode_ = m; } };
extern WiFiShim WiFi;
#endif
