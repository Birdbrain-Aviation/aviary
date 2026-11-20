// Stand-in Adafruit Unified Sensor types.
#pragma once
#include "Arduino.h"
#define SENSORS_GRAVITY_EARTH 9.80665F
#define SENSORS_GRAVITY_STANDARD SENSORS_GRAVITY_EARTH
#define SENSORS_PRESSURE_SEALEVELHPA 1013.25F
#define SENSORS_DPS_TO_RADS 0.017453293F
#define SENSORS_RADS_TO_DPS 57.29577793F
typedef struct {
  union { float v[3]; struct { float x; float y; float z; }; struct { float roll; float pitch; float heading; }; };
  int8_t status; uint8_t reserved[3];
} sensors_vec_t;
typedef struct {
  int32_t version, sensor_id, type, reserved0, timestamp;
  union { float data[4]; sensors_vec_t acceleration; sensors_vec_t magnetic; sensors_vec_t orientation; sensors_vec_t gyro;
          float temperature; float distance; float light; float pressure; float relative_humidity; float current; float voltage; };
} sensors_event_t;
typedef struct { char name[12]; int32_t version, sensor_id, type; float max_value, min_value, resolution; int32_t min_delay; } sensor_t;
class Adafruit_Sensor {
 public:
  virtual ~Adafruit_Sensor() {}
  virtual bool getEvent(sensors_event_t*) = 0;
  virtual void getSensor(sensor_t*) {}
};
