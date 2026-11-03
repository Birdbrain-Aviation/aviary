// How to add Mockingbird testing to your own flight computer.
//
// The pattern is small:
//   1. Read the real sensors when no test is running, and Mockingbird's
//      simulated ones when a test is (hil.active()).
//   2. Time things with hil.millis(), which is the simulated clock during a
//      test and the normal millis() otherwise.
//   3. Never fire a real charge during a test: report it with hil.pyro().
//   4. Report what your code decided, so Mockingbird can grade it.
//
// This sketch compiles as-is. Replace the two read...() functions with your
// sensor library calls and put your flight logic where it says so.
//
// SAFETY: before every test, take out igniters and e-matches and unplug the
// pyro battery. Mockingbird makes the flight computer believe it is flying.

#include <MockingbirdHIL.h>

MockingbirdHIL hil(Serial);

// Pyro output pins by channel number (index 0 is unused).
const uint8_t PYRO_PINS[] = { 0, 5, 6 };
const uint8_t PYRO_COUNT = sizeof(PYRO_PINS) - 1;
uint32_t pyroOffAt[sizeof(PYRO_PINS)] = { 0 };

// ---- replace these with your sensor libraries ----
float readPressurePa() { return NAN; }   // e.g. return bmp.readPressure();
float readAccelUpG() { return NAN; }     // e.g. return imu.getAccelZ() / 9.80665;

// One place decides where readings come from.
float pressurePa() { return hil.active() ? hil.pressure() : readPressurePa(); }
float accelUpG() { return hil.active() ? hil.accelG(2) : readAccelUpG(); }   // 2 = Z axis
uint32_t nowMs() { return hil.millis(); }

void firePyro(uint8_t ch) {
  if (ch < 1 || ch > PYRO_COUNT) return;
  if (hil.active()) {           // testing: tell Mockingbird, never fire
    hil.pyro(ch);
    return;
  }
  digitalWrite(PYRO_PINS[ch], HIGH);
  pyroOffAt[ch] = millis() + 1000;   // switch it off again after 1 s
}

void servicePyros() {
  for (uint8_t ch = 1; ch <= PYRO_COUNT; ch++) {
    if (pyroOffAt[ch] && (int32_t)(millis() - pyroOffAt[ch]) >= 0) {
      digitalWrite(PYRO_PINS[ch], LOW);
      pyroOffAt[ch] = 0;
    }
  }
}

void resetFlightState() {
  // put your state machine back to "on the pad" here
}

void setup() {
  for (uint8_t ch = 1; ch <= PYRO_COUNT; ch++) {
    pinMode(PYRO_PINS[ch], OUTPUT);
    digitalWrite(PYRO_PINS[ch], LOW);
  }
  Serial.begin(115200);          // must match the baud rate in Mockingbird
  hil.begin("My flight computer");
}

void loop() {
  servicePyros();
  bool sample = hil.poll();
  if (hil.testStarted()) resetFlightState();
  if (hil.active() && !sample) return;   // in a test, run once per simulated sample

  float p = pressurePa();
  float a = accelUpG();
  uint32_t t = nowMs();
  (void)p; (void)a; (void)t;

  // ---- your flight logic goes here, unchanged ----
  // When it decides something, also report it:
  //   hil.event(F("LAUNCH"));   hil.event(F("APOGEE"));   hil.event(F("LANDED"));
  //   hil.state(F("COAST"));    // your state machine's name for where it is
  //   hil.telemetry("alt", altitudeEstimate, "vel", velocityEstimate);   // a few times a second
  //   firePyro(1);              // reports instead of firing during a test
  //
  // Reports are only sent while a test is running, so they never clutter a
  // real flight's serial output.
}
