// Stand-in Adafruit MPU6050: acceleration (m/s²) and rotation (rad/s) from the
// simulation, in the board's axes. Readings saturate at the configured range,
// which starts at the chip's power-on ranges (±2 g, ±250 °/s) until the
// sketch sets it, so forgetting setAccelerometerRange() shows up in a test.
// The chip powers up asleep: until begin() wakes it, every reading is zero.
#pragma once
#include "Arduino.h"
#include "Adafruit_Sensor.h"
#include "Wire.h"
#define MPU6050_I2CADDR_DEFAULT 0x68
typedef enum { MPU6050_RANGE_2_G = 0, MPU6050_RANGE_4_G, MPU6050_RANGE_8_G, MPU6050_RANGE_16_G } mpu6050_accel_range_t;
typedef enum { MPU6050_RANGE_250_DEG = 0, MPU6050_RANGE_500_DEG, MPU6050_RANGE_1000_DEG, MPU6050_RANGE_2000_DEG } mpu6050_gyro_range_t;
typedef enum { MPU6050_BAND_260_HZ = 0, MPU6050_BAND_184_HZ, MPU6050_BAND_94_HZ, MPU6050_BAND_44_HZ, MPU6050_BAND_21_HZ, MPU6050_BAND_10_HZ, MPU6050_BAND_5_HZ } mpu6050_bandwidth_t;
typedef enum { MPU6050_HIGHPASS_DISABLE } mpu6050_highpass_t;
class Adafruit_MPU6050 {
  mpu6050_accel_range_t ar_ = MPU6050_RANGE_2_G;
  mpu6050_gyro_range_t gr_ = MPU6050_RANGE_250_DEG;
  mpu6050_bandwidth_t bw_ = MPU6050_BAND_260_HZ;
  bool awake_ = false;
 public:
  bool begin(uint8_t = MPU6050_I2CADDR_DEFAULT, TwoWire* = &Wire, int32_t = 0) { return awake_ = true; }
  void setAccelerometerRange(mpu6050_accel_range_t r) { ar_ = r; }
  mpu6050_accel_range_t getAccelerometerRange() { return ar_; }
  void setGyroRange(mpu6050_gyro_range_t r) { gr_ = r; }
  mpu6050_gyro_range_t getGyroRange() { return gr_; }
  void setFilterBandwidth(mpu6050_bandwidth_t b) { bw_ = b; }
  mpu6050_bandwidth_t getFilterBandwidth() { return bw_; }
  void setSampleRateDivisor(uint8_t) {}
  void setHighPassFilter(mpu6050_highpass_t) {}
  void setMotionInterrupt(bool) {}
  void setInterruptPinLatch(bool) {}
  void setInterruptPinPolarity(bool) {}
  void enableSleep(bool) {}
  void enableCycle(bool) {}
  bool getEvent(sensors_event_t* a, sensors_event_t* g, sensors_event_t* t) {
    bench::cost(500);
    const bench::Sample& s = bench::sample();
    const float aMax = 9.80665f * (2 << ar_), gMax = 250.0f * (1 << gr_) * 0.017453293f;
    auto ca = [&](double v) { return !awake_ || isnan(v) ? 0.0f : constrain((float)v, -aMax, aMax); };
    auto cg = [&](double v) { return !awake_ || isnan(v) ? 0.0f : constrain((float)(v * 0.017453293), -gMax, gMax); };
    if (a) { memset(a, 0, sizeof *a); a->type = 1; a->timestamp = (int32_t)millis(); a->acceleration.x = ca(s.ax); a->acceleration.y = ca(s.ay); a->acceleration.z = ca(s.az); }
    if (g) { memset(g, 0, sizeof *g); g->type = 4; g->timestamp = (int32_t)millis(); g->gyro.x = cg(s.gx); g->gyro.y = cg(s.gy); g->gyro.z = cg(s.gz); }
    if (t) { memset(t, 0, sizeof *t); t->type = 13; t->temperature = isnan(s.temp) ? 25.0f : (float)s.temp; }
    return true;
  }
};
