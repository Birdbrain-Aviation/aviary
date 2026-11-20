// Stand-in Adafruit BMP280: pressure (Pa) and temperature from the simulation.
#pragma once
#include "Arduino.h"
#include "Adafruit_Sensor.h"
#include "Wire.h"
#define BMP280_ADDRESS 0x77
#define BMP280_ADDRESS_ALT 0x76
#define BMP280_CHIPID 0x58
class Adafruit_BMP280 {
  float p_ = 101325, t_ = 15;
  void read() { bench::cost(600); const bench::Sample& s = bench::sample(); if (!isnan(s.p)) { p_ = (float)s.p; t_ = (float)s.temp; } }
 public:
  enum sensor_sampling { SAMPLING_NONE, SAMPLING_X1, SAMPLING_X2, SAMPLING_X4, SAMPLING_X8, SAMPLING_X16 };
  enum sensor_mode { MODE_SLEEP = 0, MODE_FORCED = 1, MODE_NORMAL = 3, MODE_SOFT_RESET_CODE = 0xB6 };
  enum sensor_filter { FILTER_OFF, FILTER_X2, FILTER_X4, FILTER_X8, FILTER_X16 };
  enum standby_duration { STANDBY_MS_1, STANDBY_MS_63, STANDBY_MS_125, STANDBY_MS_250, STANDBY_MS_500, STANDBY_MS_1000, STANDBY_MS_2000, STANDBY_MS_4000 };
  Adafruit_BMP280(TwoWire* = &Wire) {}
  Adafruit_BMP280(int8_t, SPIClass* = nullptr) {}
  bool on_ = false;   // without begin() there is no calibration data: readings are NaN
  bool begin(uint8_t = BMP280_ADDRESS, uint8_t = BMP280_CHIPID) { return on_ = true; }
  void setSampling(sensor_mode = MODE_NORMAL, sensor_sampling = SAMPLING_X16, sensor_sampling = SAMPLING_X16, sensor_filter = FILTER_OFF, standby_duration = STANDBY_MS_1) {}
  uint8_t sensorID() { return BMP280_CHIPID; }
  uint8_t getStatus() { return 0; }
  bool takeForcedMeasurement() { return true; }
  float readTemperature() { read(); return on_ ? t_ : NAN; }
  float readPressure() { read(); return on_ ? p_ : NAN; }
  float readAltitude(float seaLevelhPa = 1013.25) { read(); if (!on_) return NAN; return 44330.0f * (1.0f - powf(p_ / 100.0f / seaLevelhPa, 0.1903f)); }
};
