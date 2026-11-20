// MockingbirdAirbrakes: a dual-deploy flight computer with airbrakes that aim
// for a target apogee (as in the American Rocketry Challenge), and a tilt
// estimate from the gyros. Like MockingbirdTry it only flies inside
// Mockingbird and never touches any pins; on a real board, setBrake() would
// move the servo.
//
// In Mockingbird, pick a rocket with airbrakes and a target apogee (the
// "Example: airbrakes to a target" profile matches the settings below), turn
// on gyro fields, and run Normal flight, Strong motor and a Monte Carlo batch.
//
// How it works:
//  - Altitude from the barometer, zeroed on the pad and scaled by the pad's
//    temperature (the standard formula assumes 15 °C and reads about 1.7% low
//    at 20 °C: enough to miss a target by 10 m).
//  - Height and vertical speed for the airbrakes from the accelerometer,
//    integrated from liftoff and nudged by the barometer. A barometer-only
//    speed lags while the rocket slows, which makes airbrakes open too far.
//  - Tilt: "down" is learned from gravity on the pad, then the gyros turn it.
//  - After burnout it predicts apogee for a vertical coast with drag,
//      apogee = h + ln(1 + k v² / g) / (2k),  k = ρ (CdA + e·CdA_brake) / (2 m cos tilt)
//    and picks the brake opening e (0 to 1) that lands it on the target.

#include <MockingbirdHIL.h>
#include <math.h>

MockingbirdHIL hil(Serial);

// ---- settings: match the rocket profile in Mockingbird ----
const uint8_t UP_AXIS = 2;            // board axis toward the nose: 0 = X, 1 = Y, 2 = Z
const float UP_SIGN = 1.0;            // -1.0 if that axis points to the tail
const uint8_t DROGUE_CH = 1, MAIN_CH = 2;
const float DROGUE_DELAY_S = 1.0;     // after apogee
const float MAIN_ALT_M = 152.4;       // 500 ft
const float TARGET_M = 518.2;         // 1,700 ft
const float COAST_MASS_KG = 0.8625;   // after burnout: dry mass + empty motor
const float CDA = 0.5 * 0.00229;      // body Cd × frontal area (m²)
const float BRAKE_CDA = 1.2 * 0.004;  // airbrake Cd × area when fully open (m²)

const float G = 9.80665f;
enum Phase : uint8_t { PAD, BOOST, COAST, DESCENT, UNDER_MAIN, LANDED };
Phase phase = PAD;
float p0 = 0, tPad = 15, alt = 0, vel = 0, maxAlt = 0;    // barometer
float hI = 0, vI = 0;                          // accelerometer, for the brakes
float R[3][3];                                 // rows: world axes in board axes
float gPad[3] = {0, 0, G};
float tilt = 0, brake = 0, rho = 1.2;
uint16_t padN = 0;
uint32_t lastT = 0, launchT = 0, burnT = 0, apogeeT = 0, brakeSentT = 0, landT = 0;
uint8_t boostN = 0, belowN = 0, n = 0;
bool drogueFired = false;

void setPhase(Phase p, const __FlashStringHelper* name) { phase = p; hil.state(name); }

void resetFlight() {
  phase = PAD; p0 = alt = vel = maxAlt = hI = vI = tilt = brake = 0; tPad = 15;
  gPad[0] = gPad[1] = 0; gPad[2] = G;
  padN = 0; lastT = launchT = burnT = apogeeT = brakeSentT = landT = 0;
  boostN = belowN = n = 0; drogueFired = false;
}

void setBrake(float e) {
  brake = e;
  hil.actuator("brake", e);      // on a real board: brakeServo.write(CLOSED + e * (OPEN - CLOSED));
}

// Start the attitude from gravity on the pad: world "up" in board axes.
void startAttitude() {
  float n0 = sqrtf(gPad[0] * gPad[0] + gPad[1] * gPad[1] + gPad[2] * gPad[2]);
  float z[3] = {gPad[0] / n0, gPad[1] / n0, gPad[2] / n0};
  float x[3] = {1, 0, 0};
  if (fabsf(z[0]) > 0.9f) { x[0] = 0; x[1] = 1; }
  float d = x[0] * z[0] + x[1] * z[1] + x[2] * z[2];
  for (int i = 0; i < 3; i++) x[i] -= d * z[i];
  float nx = sqrtf(x[0] * x[0] + x[1] * x[1] + x[2] * x[2]);
  for (int i = 0; i < 3; i++) { x[i] /= nx; R[0][i] = x[i]; R[2][i] = z[i]; }
  R[1][0] = z[1] * x[2] - z[2] * x[1]; R[1][1] = z[2] * x[0] - z[0] * x[2]; R[1][2] = z[0] * x[1] - z[1] * x[0];
}

// Turn the attitude by the gyro rates (rad/s) for dt seconds, keep it a rotation.
void turn(const float w[3], float dt) {
  for (int r = 0; r < 3; r++) {
    float a = R[r][0], b = R[r][1], c = R[r][2];
    R[r][0] = a + (b * w[2] - c * w[1]) * dt;
    R[r][1] = b + (c * w[0] - a * w[2]) * dt;
    R[r][2] = c + (a * w[1] - b * w[0]) * dt;
  }
  float nz = sqrtf(R[2][0] * R[2][0] + R[2][1] * R[2][1] + R[2][2] * R[2][2]);
  for (int i = 0; i < 3; i++) R[2][i] /= nz;
  float d = R[0][0] * R[2][0] + R[0][1] * R[2][1] + R[0][2] * R[2][2];
  for (int i = 0; i < 3; i++) R[0][i] -= d * R[2][i];
  float nx = sqrtf(R[0][0] * R[0][0] + R[0][1] * R[0][1] + R[0][2] * R[0][2]);
  for (int i = 0; i < 3; i++) R[0][i] /= nx;
  R[1][0] = R[2][1] * R[0][2] - R[2][2] * R[0][1];
  R[1][1] = R[2][2] * R[0][0] - R[2][0] * R[0][2];
  R[1][2] = R[2][0] * R[0][1] - R[2][1] * R[0][0];
}

float predictApogee(float e, float h, float v) {
  float c = cosf(tilt * DEG_TO_RAD);
  if (c < 0.5f) c = 0.5f;
  float k = rho * (CDA + e * BRAKE_CDA) / (2 * COAST_MASS_KG * c);
  return h + logf(1 + k * v * v / G) / (2 * k);
}

void setup() {
  Serial.begin(115200);
  hil.begin("MockingbirdAirbrakes");
}

void loop() {
  bool sample = hil.poll();
  if (hil.testStarted()) resetFlight();
  if (!sample) return;

  uint32_t t = hil.sampleTime();
  float dt = lastT ? (t - lastT) / 1000.0f : 0.02f;
  if (dt <= 0) dt = 0.001f;
  lastT = t;

  // barometer
  float p = hil.pressure(), T = hil.temperature();
  if (!isnan(p)) {
    if (phase == PAD) {
      padN++;
      p0 = (p0 == 0) ? p : p0 + (p - p0) / (padN < 100 ? padN : 100);
      if (!isnan(T)) tPad += (T - tPad) / (padN < 100 ? padN : 100);
    }
    float h = 44330.77f * ((273.15f + tPad) / 288.15f) * (1.0f - pow(p / p0, 0.190263f));
    float pred = alt + vel * dt, r = h - pred;
    alt = pred + 0.2f * r;
    vel += 0.02f * r / dt;
    if (!isnan(T)) rho = p / (287.05f * (T + 273.15f));
  }
  if (alt > maxAlt) maxAlt = alt;

  // accelerometer and gyros
  float a[3] = {hil.accel(0), hil.accel(1), hil.accel(2)};
  float accUp = a[UP_AXIS] * UP_SIGN;
  float mag = sqrtf(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  if (phase == PAD) {
    // learn "down" only while sitting still: under thrust it reads the motor
    if (mag > 0.85f * G && mag < 1.15f * G) for (int i = 0; i < 3; i++) gPad[i] += (a[i] - gPad[i]) * 0.05f;
    tilt = acosf(gPad[UP_AXIS] * UP_SIGN / sqrtf(gPad[0] * gPad[0] + gPad[1] * gPad[1] + gPad[2] * gPad[2])) * RAD_TO_DEG;
    // integrate from the first push, forget it if it was only a knock
    if (accUp < 1.15f * G && boostN == 0) { hI = vI = 0; }
    else { vI += (accUp - G) * dt; hI += vI * dt; }
    if (accUp >= 1.15f * G && boostN == 0) startAttitude();
  } else if (phase != LANDED) {
    const float d2r = (float)DEG_TO_RAD;
    float w[3] = {hil.gyro(0) * d2r, hil.gyro(1) * d2r, hil.gyro(2) * d2r};
    turn(w, dt);
    tilt = acosf(constrain(R[2][UP_AXIS] * UP_SIGN, -1.0f, 1.0f)) * RAD_TO_DEG;
    if (phase == BOOST || phase == COAST) {
      vI += (accUp * cosf(tilt * DEG_TO_RAD) - G) * dt;
      hI += vI * dt;
      vI += 0.002f * (vel - vI);
      hI += 0.02f * (alt - hI);
    }
  }
  if (++n % 5 == 0) hil.telemetry("alt", alt, "vel", vel, "tilt", tilt);

  switch (phase) {
    case PAD:
      boostN = (accUp > 2.5f * G) ? boostN + 1 : 0;
      if (boostN >= 3 && alt > 2) { launchT = t; hil.event(F("LAUNCH")); setPhase(BOOST, F("BOOST")); }
      break;
    case BOOST:
      if (accUp < 0.5f * G) { burnT = t; hil.event(F("BURNOUT")); setPhase(COAST, F("COAST")); }
      break;
    case COAST: {
      // airbrakes: from 0.3 s after burnout until apogee
      // (nearly at apogee they can't do much: hold them where they are)
      if (t - burnT > 300 && vI > 8) {
        float e;
        if (predictApogee(0, hI, vI) <= TARGET_M) e = 0;
        else if (predictApogee(1, hI, vI) >= TARGET_M) e = 1;
        else {
          float lo = 0, hi = 1;
          for (int i = 0; i < 14; i++) { float m = (lo + hi) / 2; if (predictApogee(m, hI, vI) > TARGET_M) lo = m; else hi = m; }
          e = (lo + hi) / 2;
        }
        if (fabsf(e - brake) > 0.02f || t - brakeSentT > 200) { setBrake(e); brakeSentT = t; }
      }
      belowN = (vel < 0) ? belowN + 1 : 0;
      if ((t - launchT > 2000 && belowN >= 3) || maxAlt - alt > 3) {
        apogeeT = t;
        hil.event(F("APOGEE"));
        setPhase(DESCENT, F("DESCENT"));
        setBrake(0);                       // close them for the descent
      }
      break;
    }
    case DESCENT:
      if (!drogueFired && t - apogeeT >= DROGUE_DELAY_S * 1000) { drogueFired = true; hil.pyro(DROGUE_CH); hil.log(F("Drogue")); }
      if (alt < MAIN_ALT_M && vel < 0) { hil.pyro(MAIN_CH); hil.log(F("Main")); setPhase(UNDER_MAIN, F("MAIN")); }
      break;
    case UNDER_MAIN:
      if (alt < 10 && fabsf(vel) < 1.5f) {
        if (!landT) landT = t;
        if (t - landT > 2000) { hil.event(F("LANDED")); setPhase(LANDED, F("LANDED")); }
      } else landT = 0;
      break;
    case LANDED:
      break;
  }
}
