// Stand-in Adafruit BMP3XX (BMP388 / BMP390): pressure and temperature from
// the simulation. performReading() returns false while the barometer has
// dropped out or before begin_I2C()/begin_SPI(), and keeps the previous values.
#pragma once
#include "Arduino.h"
#include "Adafruit_Sensor.h"
#include "Wire.h"
#include "SPI.h"
#define BMP3XX_DEFAULT_ADDRESS 0x77
#define BMP3_NO_OVERSAMPLING 0
#define BMP3_OVERSAMPLING_2X 1
#define BMP3_OVERSAMPLING_4X 2
#define BMP3_OVERSAMPLING_8X 3
#define BMP3_OVERSAMPLING_16X 4
#define BMP3_OVERSAMPLING_32X 5
#define BMP3_IIR_FILTER_DISABLE 0
#define BMP3_IIR_FILTER_COEFF_1 1
#define BMP3_IIR_FILTER_COEFF_3 2
#define BMP3_IIR_FILTER_COEFF_7 3
#define BMP3_IIR_FILTER_COEFF_15 4
#define BMP3_IIR_FILTER_COEFF_31 5
#define BMP3_IIR_FILTER_COEFF_63 6
#define BMP3_IIR_FILTER_COEFF_127 7
#define BMP3_ODR_200_HZ 0
#define BMP3_ODR_100_HZ 1
#define BMP3_ODR_50_HZ 2
#define BMP3_ODR_25_HZ 3
#define BMP3_ODR_12_5_HZ 4
class Adafruit_BMP3XX {
  bool on_ = false;
 public:
  double temperature = 15, pressure = 101325;
  bool begin_I2C(uint8_t = BMP3XX_DEFAULT_ADDRESS, TwoWire* = &Wire) { return on_ = true; }
  bool begin_SPI(int8_t, SPIClass* = &SPI, uint32_t = 1000000) { return on_ = true; }
  bool begin_SPI(int8_t, int8_t, int8_t, int8_t) { return on_ = true; }
  uint8_t chipID() { return 0x60; }
  bool setTemperatureOversampling(uint8_t) { return true; }
  bool setPressureOversampling(uint8_t) { return true; }
  bool setIIRFilterCoeff(uint8_t) { return true; }
  bool setOutputDataRate(uint8_t) { return true; }
  bool performReading() {
    bench::cost(1000);
    const bench::Sample& s = bench::sample();
    if (!on_ || isnan(s.p)) return false;
    pressure = s.p; temperature = s.temp;
    return true;
  }
  float readPressure() { performReading(); return (float)pressure; }
  float readTemperature() { performReading(); return (float)temperature; }
  float readAltitude(float seaLevel) { performReading(); return 44330.0f * (1.0f - powf((float)(pressure / 100.0) / seaLevel, 0.1903f)); }
};
