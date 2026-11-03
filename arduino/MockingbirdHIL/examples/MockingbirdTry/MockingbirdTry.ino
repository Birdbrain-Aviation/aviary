// MockingbirdTry: a small dual-deploy flight computer that only flies inside
// Mockingbird. Flash it to any Arduino-compatible board (Uno, Nano, Pico,
// STM32, ESP32...), connect Mockingbird to the board's port, and run a test.
//
// It does the same thing as Mockingbird's built-in virtual flight computer:
// launch and burnout detection, apogee from the barometer, drogue at apogee,
// main at 500 ft, and optional staging. It never touches any pins, so it is
// safe on a bare board. Copy the parts you like into your own firmware.

#include <MockingbirdHIL.h>

MockingbirdHIL hil(Serial);

// ---- settings: match the rocket profile and pyro channels in Mockingbird ----
const uint8_t UP_AXIS = 2;            // accelerometer axis that points to the nose: 0 = X, 1 = Y, 2 = Z
const float UP_SIGN = 1.0;            // -1.0 if that axis points to the tail
const uint8_t DROGUE_CH = 1;          // pyro channel numbers (0 = not fitted)
const uint8_t MAIN_CH = 2;
const float DROGUE_DELAY_S = 1.0;     // after apogee
const float MAIN_ALT_M = 152.4;       // 500 ft
const uint8_t STAGE_CH = 0;           // channel that lights stage 2 (0 = single stage)
const float STAGE_DELAY_S = 1.0;      // after the booster burns out

enum Phase : uint8_t { PAD, BOOST, COAST, DESCENT, UNDER_MAIN, LANDED };
Phase phase = PAD;
float p0 = 0, alt = 0, vel = 0, maxAlt = 0;
uint16_t padN = 0;
uint32_t lastT = 0, launchT = 0, burnT = 0, apogeeT = 0, landT = 0;
uint32_t candT = 0, pushMs = 0;       // launch candidate: confirmed only if a climb follows
float candAlt = 0;
bool cand = false;
uint8_t boostN = 0, belowN = 0, n = 0;
bool drogueFired = false, mainFired = false, staged = false;

void setPhase(Phase p, const __FlashStringHelper* name) {
  phase = p;
  hil.state(name);
}

void resetFlight() {
  phase = PAD;
  p0 = alt = vel = maxAlt = 0;
  padN = 0;
  lastT = launchT = burnT = apogeeT = landT = 0;
  candT = pushMs = 0; candAlt = 0; cand = false;
  boostN = belowN = n = 0;
  drogueFired = mainFired = staged = false;
}

void setup() {
  Serial.begin(115200);
  hil.begin("MockingbirdTry");
}

void loop() {
  bool sample = hil.poll();
  if (hil.testStarted()) resetFlight();
  if (!sample) return;                       // run once per simulated sample

  uint32_t t = hil.sampleTime();             // ms
  uint32_t dtMs = lastT ? t - lastT : 20;
  float dt = dtMs / 1000.0f;
  if (dt <= 0) dt = 0.001f;
  lastT = t;

  // Barometric altitude, zeroed on the pad, smoothed with an alpha-beta filter.
  float p = hil.pressure();
  if (!isnan(p)) {
    if (phase == PAD) {
      padN++;
      p0 = (p0 == 0) ? p : p0 + (p - p0) / (padN < 100 ? padN : 100);
    }
    float h = 44330.77f * (1.0f - pow(p / p0, 0.190263f));
    float pred = alt + vel * dt;
    float r = h - pred;
    alt = pred + 0.2f * r;
    vel += 0.02f * r / dt;
  }
  if (alt > maxAlt) maxAlt = alt;
  float accUp = hil.accel(UP_AXIS) * UP_SIGN;   // m/s², about +9.8 on the pad
  if (++n % 5 == 0) hil.telemetry("alt", alt, "vel", vel);

  switch (phase) {
    case PAD:
      // A spike only makes a launch candidate. Launch is confirmed once the
      // push has lasted 0.15 s and the altitude has climbed 3 m, so a knock
      // on the pad or loading the rail is ignored.
      boostN = (accUp > 2.5f * 9.81f) ? boostN + 1 : 0;
      if (!cand && (boostN >= 3 || (alt > 10 && vel > 8))) { cand = true; candT = t; candAlt = alt; pushMs = 0; }
      if (cand) {
        if (isnan(accUp) || accUp > 1.2f * 9.81f) pushMs += dtMs;
        if (pushMs >= 150 && alt - candAlt > 3 && vel > 5) {
          launchT = candT;                 // back-dated to when the push began
          hil.event(F("LAUNCH"));
          setPhase(BOOST, F("BOOST"));
        } else if (t - candT > 1500) cand = false;   // no climb followed: it was a bump
      }
      break;
    case BOOST:
      if (accUp < 0.5f * 9.81f || (isnan(accUp) && t - launchT > 1000 && vel > 0)) {
        burnT = t;
        hil.event(F("BURNOUT"));
        setPhase(COAST, F("COAST"));
      }
      break;
    case COAST:
      if (STAGE_CH && !staged && t - burnT >= STAGE_DELAY_S * 1000) {
        staged = true;
        if (vel > 15) {
          hil.pyro(STAGE_CH);
          hil.log(F("Lighting the next stage"));
          boostN = 0;
          setPhase(BOOST, F("BOOST"));
          break;
        }
        hil.log(F("Staging inhibited: too slow"));
      }
      belowN = (vel < 0) ? belowN + 1 : 0;
      if ((t - launchT > 2000 && belowN >= 3) || maxAlt - alt > 3) {
        apogeeT = t;
        hil.event(F("APOGEE"));
        setPhase(DESCENT, F("DESCENT"));
      }
      break;
    case DESCENT:
      if (MAIN_CH && alt < MAIN_ALT_M && vel < 0) {
        mainFired = true;
        hil.pyro(MAIN_CH);
        hil.log(F("Main"));
        setPhase(UNDER_MAIN, F("MAIN"));
      }
      break;
    case UNDER_MAIN:
      if (alt < 10 && fabs(vel) < 1.5f) {
        if (!landT) landT = t;
        if (t - landT > 2000) {
          hil.event(F("LANDED"));
          setPhase(LANDED, F("LANDED"));
        }
      } else {
        landT = 0;
      }
      break;
    case LANDED:
      break;
  }

  // The drogue fires after its delay, even if a low apogee already brought the main out.
  if ((phase == DESCENT || phase == UNDER_MAIN) && DROGUE_CH && !drogueFired && t - apogeeT >= DROGUE_DELAY_S * 1000) {
    drogueFired = true;
    hil.pyro(DROGUE_CH);
    hil.log(F("Drogue"));
  }
}
