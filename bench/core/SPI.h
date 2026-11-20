// Stand-in SPI.
#pragma once
#include "Arduino.h"
#define MSBFIRST 1
#define LSBFIRST 0
#define SPI_MODE0 0
#define SPI_MODE1 1
#define SPI_MODE2 2
#define SPI_MODE3 3
struct SPISettings { SPISettings() {} SPISettings(uint32_t, uint8_t, uint8_t) {} };
class SPIClass {
 public:
  void begin() {}
  void end() {}
  void beginTransaction(SPISettings) {}
  void endTransaction() {}
  uint8_t transfer(uint8_t) { return 0; }
  void setDataMode(uint8_t) {}
  void setClockDivider(uint8_t) {}
};
inline SPIClass SPI;
