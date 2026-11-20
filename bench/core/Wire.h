// Stand-in I2C: every device answers; the sensor libraries read the simulation.
#pragma once
#include "Arduino.h"
class TwoWire : public Stream {
 public:
  void begin() {}
  void begin(int, int) {}
  void begin(uint8_t) {}
  void end() {}
  void setClock(uint32_t) {}
  void beginTransmission(uint8_t) {}
  uint8_t endTransmission(bool = true) { return 0; }
  uint8_t requestFrom(uint8_t, uint8_t n, bool = true) { return n; }
  size_t write(uint8_t) override { return 1; }
  using Print::write;
  int available() override { return 0; }
  int read() override { return 0; }
};
inline TwoWire Wire, Wire1;
