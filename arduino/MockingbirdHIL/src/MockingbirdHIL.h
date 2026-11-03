// MockingbirdHIL: hardware-in-the-loop testing for rocket flight computers.
//
// While Mockingbird (the Windows app) runs a test, it streams simulated sensor
// readings over serial. This library reads them, so your firmware can use them
// instead of its real sensors, and sends your firmware's decisions (pyro
// channels, events, its own altitude estimate) back to Mockingbird.
//
//   MockingbirdHIL hil(Serial);
//   void setup() { Serial.begin(115200); hil.begin("Fledgling"); }
//   void loop() {
//     if (hil.poll()) {                   // a new simulated sample arrived
//       float p = hil.pressure();         // Pa
//       float a = hil.accelG(2);          // g along Z
//       uint32_t t = hil.millis();        // simulated time
//       ... your flight logic ...
//       if (deployNow) hil.pyro(1);       // instead of firing a real charge
//     }
//   }
//
// It uses no heap, about 330 bytes of RAM on an Arduino Uno/Nano (less with a
// smaller MB_LINE_MAX), and works on
// AVR, RP2040/RP2350, STM32, ESP32, Teensy and other Arduino cores.
//
// SAFETY: remove igniters/e-matches and unplug the pyro battery while testing.
// Mockingbird makes your flight computer believe it is flying.

#ifndef MOCKINGBIRD_HIL_H
#define MOCKINGBIRD_HIL_H

#include <Arduino.h>

#ifndef MB_LINE_MAX
#if defined(__AVR__)
#define MB_LINE_MAX 160   // longest line accepted; a sample with every field is about 150
#else
#define MB_LINE_MAX 320
#endif
#endif

#ifndef MB_MAX_COLS
#define MB_MAX_COLS 24
#endif

class MockingbirdHIL {
 public:
  // Field numbers (also the order of the names Mockingbird uses).
  enum Field : uint8_t {
    NONE = 0, T_MS, P_PA, TEMP_C, ALT_M, VZ, AX, AY, AZ, AX_G, AY_G, AZ_G, GX, GY, GZ, LAT, LON, GPS_ALT, SATS, FIELD_COUNT
  };

  explicit MockingbirdHIL(Stream& port);

  // Call once after Serial.begin(). Tells Mockingbird the board is ready.
  void begin(const char* name = "flight computer");

  // Call every loop(). Reads what Mockingbird sent. Returns true when a new
  // sample has arrived (one per call, so you can process each one).
  bool poll();

  // True while a test is running. Use real sensors and real pyros when false.
  bool active() const { return _active; }

  // True once at the start of each test (reset your flight state machine) and
  // once when a test ends.
  bool testStarted();
  bool testEnded();

  // ---- the latest simulated sample (NAN when that field wasn't sent) ----
  uint32_t sampleTime() const { return _tms; }  // ms since the test started
  uint32_t millis();                            // sample clock in a test, else ::millis()
  float pressure() const { return _v[P_PA]; }      // Pa
  float temperature() const { return _v[TEMP_C]; } // °C
  float accel(uint8_t axis) const;   // m/s², axis 0 = X, 1 = Y, 2 = Z (+1 g up on the pad)
  float accelG(uint8_t axis) const;  // the same in g
  float gyro(uint8_t axis) const;    // °/s
  bool hasGPS() const { return _latE7 != 0 || _lonE7 != 0; }
  int32_t latitudeE7() const { return _latE7; }    // degrees × 10^7, full precision even on AVR
  int32_t longitudeE7() const { return _lonE7; }
  double latitude() const { return _latE7 / 1e7; }
  double longitude() const { return _lonE7 / 1e7; }
  float gpsAltitude() const { return _v[GPS_ALT]; }  // m above sea level
  uint8_t satellites() const;
  float trueAltitude() const { return _v[ALT_M]; }       // only if "alt_m" is ticked (debugging)
  float trueVerticalSpeed() const { return _v[VZ]; }     // only if "vz" is ticked
  bool has(Field f) const { return f < FIELD_COUNT && _sent[f]; }  // was this field in the header?

  uint16_t rate() const { return _rate; }      // samples per second
  float timeScale() const { return _scale; }   // 1 = real time
  uint32_t samples() const { return _good; }   // good samples this test
  uint16_t damaged() const { return _bad; }    // lines that failed their checksum or overflowed

  // ---- reporting back to Mockingbird ----
  void pyro(uint8_t channel);                         // "I fired pyro channel n"
  void event(const char* name);                       // e.g. "LAUNCH", "BURNOUT", "APOGEE", "LANDED"
  void event(const __FlashStringHelper* name);
  void event(const char* name, const char* value);
  void state(const char* name);                       // your state machine, e.g. "COAST"
  void state(const __FlashStringHelper* name);
  void telemetry(const char* name, float value);      // plotted against the truth, e.g. "alt", "vel"
  void telemetry(const char* n1, float v1, const char* n2, float v2);
  void telemetry(const char* n1, float v1, const char* n2, float v2, const char* n3, float v3);
  void log(const char* text);                         // a note shown in Mockingbird's event list
  void log(const __FlashStringHelper* text);

 private:
  Stream& _port;
  const char* _name;
  char _buf[MB_LINE_MAX];
  uint16_t _len;
  bool _overflow;
  bool _active, _started, _ended;
  uint8_t _map[MB_MAX_COLS];
  uint8_t _ncols;
  bool _sent[FIELD_COUNT];
  float _v[FIELD_COUNT];
  int32_t _latE7, _lonE7;
  uint32_t _tms, _rxAt, _rxUs, _lastRx, _lastStats, _lastClock;
  uint16_t _rate;
  float _scale;
  uint32_t _good;
  uint16_t _bad;

  bool _handle(char* s);
  void _data(char* s);
  void _header(char* s);
  void _control(char* s);
  void _start(uint16_t rate, float scale);
  void _stop();
  void _stats();
  void _clearValues();
  void _tag(const __FlashStringHelper* tag);
};

#endif
