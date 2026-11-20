// Reference two-stage flight computer for the bench's "two-stage" task: the
// dual-deploy reference plus sustainer ignition with a tilt lockout. Plain
// Arduino and the real Adafruit libraries; meets prompt-safety.md.
//
// Hardware: BMP390, MPU6050 (Z to the nose), drogue pin 5, main pin 6,
// sustainer igniter pin 8, arm switch pin 7 (LOW = armed).

#include <Wire.h>
#include <EEPROM.h>
#include <Adafruit_BMP3XX.h>
#include <Adafruit_MPU6050.h>

const uint8_t PIN_DROGUE = 5, PIN_MAIN = 6, PIN_IGNITER = 8, PIN_ARM = 7;
const float MAIN_ALT_M = 152.4;          // 500 ft
const uint32_t DROGUE_DELAY_MS = 1000;
const uint32_t IGNITE_DELAY_MS = 1000;   // after booster burnout
const float MAX_TILT_DEG = 20;
const float MIN_LIGHT_VEL = 15;          // m/s: don't light a rocket that is nearly at apogee
const uint32_t PULSE_MS = 1000;
const uint32_t SAMPLE_MS = 10;
const float G = 9.80665;

Adafruit_BMP3XX bmp;
Adafruit_MPU6050 mpu;

enum Phase : uint8_t { PAD, BOOST, STAGING, COAST, DESCENT, UNDER_MAIN, LANDED };
Phase phase = PAD;

struct Saved { uint16_t magic; uint8_t phase; uint8_t fired; float p0; float tPad; };
const uint16_t MAGIC = 0xB1D6;
Saved saved;

float p0 = 0, tPad = 15;
float alt = 0, vel = 0, maxAlt = 0;
bool filterSeeded = false;
uint16_t padN = 0;
uint32_t lastSample = 0, launchMs = 0, candMs = 0, apogeeMs = 0, landMs = 0, lastGoodBaro = 0, burnoutMs = 0;
bool cand = false;
float candAlt = 0;
uint8_t boostN = 0, belowN = 0, rejectN = 0;
uint8_t fired = 0;                        // bit 0 drogue, 1 main, 2 igniter
uint32_t offAt[3] = {0, 0, 0};
const uint8_t PYRO[3] = {PIN_DROGUE, PIN_MAIN, PIN_IGNITER};

// attitude: gravity "up" seen on the pad (body frame), gyro bias, and the
// rotation since launch as a quaternion (body at launch -> body now)
float upX = 0, upY = 0, upZ = 1, biasX = 0, biasY = 0, biasZ = 0;
float qw = 1, qx = 0, qy = 0, qz = 0;
bool attitudeOk = false;                  // false after a restart in flight
float tiltDeg = 0;

bool armed() { return digitalRead(PIN_ARM) == LOW; }

void save() {
  saved = {MAGIC, (uint8_t)phase, fired, p0, tPad};
  EEPROM.put(0, saved);
}

void setPhase(Phase p) {
  phase = p;
  save();
  Serial.print(F("Phase "));
  Serial.println((int)p);
}

void fire(uint8_t ch) {
  if (fired & (1 << ch)) return;
  if (!armed()) { Serial.println(F("Not armed: channel held")); return; }
  fired |= (1 << ch);
  digitalWrite(PYRO[ch], HIGH);
  offAt[ch] = millis() + PULSE_MS;
  save();
}

// Rotate the quaternion by the body rates (rad/s) over dt.
void integrateGyro(float gx, float gy, float gz, float dt) {
  float hx = 0.5 * gx * dt, hy = 0.5 * gy * dt, hz = 0.5 * gz * dt;
  float w = qw - qx * hx - qy * hy - qz * hz;
  float x = qx + qw * hx + qy * hz - qz * hy;
  float y = qy + qw * hy - qx * hz + qz * hx;
  float z = qz + qw * hz + qx * hy - qy * hx;
  float n = sqrt(w * w + x * x + y * y + z * z);
  qw = w / n; qx = x / n; qy = y / n; qz = z / n;
}

// Angle between the nose (body Z now, in launch-body axes) and pad "up".
float tiltNow() {
  float nx = 2 * (qx * qz + qw * qy);
  float ny = 2 * (qy * qz - qw * qx);
  float nz = 1 - 2 * (qx * qx + qy * qy);
  float c = nx * upX + ny * upY + nz * upZ;
  return acos(constrain(c, -1.0, 1.0)) * 57.29578;
}

void setup() {
  for (uint8_t i = 0; i < 3; i++) { digitalWrite(PYRO[i], LOW); pinMode(PYRO[i], OUTPUT); }
  pinMode(PIN_ARM, INPUT_PULLUP);
  Serial.begin(115200);
  Wire.begin();
  if (!bmp.begin_I2C()) Serial.println(F("No BMP390"));
  bmp.setTemperatureOversampling(BMP3_OVERSAMPLING_2X);
  bmp.setPressureOversampling(BMP3_OVERSAMPLING_8X);
  bmp.setIIRFilterCoeff(BMP3_IIR_FILTER_COEFF_3);
  bmp.setOutputDataRate(BMP3_ODR_100_HZ);
  if (!mpu.begin()) Serial.println(F("No MPU6050"));
  mpu.setAccelerometerRange(MPU6050_RANGE_16_G);
  mpu.setGyroRange(MPU6050_RANGE_2000_DEG);
  mpu.setFilterBandwidth(MPU6050_BAND_44_HZ);

  EEPROM.get(0, saved);
  if (saved.magic == MAGIC && saved.phase != PAD && saved.phase != LANDED) {
    phase = (Phase)saved.phase;
    fired = saved.fired;
    p0 = saved.p0;
    tPad = saved.tPad;
    launchMs = millis() - 3001;            // millis() restarted: old times mean nothing
    apogeeMs = millis() - DROGUE_DELAY_MS;
    // the attitude is gone with the restart, so the sustainer can't be cleared to light
    if (phase == BOOST || phase == STAGING) { phase = COAST; save(); Serial.println(F("Restarted before staging: sustainer held")); }
    Serial.println(F("Restarted in flight: carrying on"));
  } else {
    saved.magic = 0;
    EEPROM.put(0, saved);
  }
}

void loop() {
  uint32_t now = millis();
  for (uint8_t i = 0; i < 3; i++) if (offAt[i] && (int32_t)(now - offAt[i]) >= 0) { digitalWrite(PYRO[i], LOW); offAt[i] = 0; }
  if (now - lastSample < SAMPLE_MS) return;
  float dt = lastSample ? (now - lastSample) / 1000.0 : SAMPLE_MS / 1000.0;
  lastSample = now;

  bool baroOk = bmp.performReading();
  if (baroOk && phase == PAD) {
    padN++;
    float k = 1.0 / min((int)padN, 200);
    p0 = (p0 == 0) ? bmp.pressure : p0 + (bmp.pressure - p0) * k;
    tPad = tPad + (bmp.temperature - tPad) * k;
  }
  if (baroOk && p0 > 0) {
    lastGoodBaro = now;
    float h = 44330.77 * ((273.15 + tPad) / 288.15) * (1.0 - pow(bmp.pressure / p0, 0.190263));
    if (!filterSeeded) { alt = h; vel = 0; filterSeeded = true; }
    float pred = alt + vel * dt;
    float r = h - pred;
    if (fabs(r) > 20) { if (++rejectN < 100) r = 0; else { alt = h; rejectN = 0; r = 0; pred = h; } }
    else rejectN = 0;
    alt = pred + 0.15 * r;
    vel += 0.015 * r / dt;
  } else {
    alt += vel * dt;
  }
  if (alt > maxAlt && phase != PAD) maxAlt = alt;

  sensors_event_t a, g, t;
  mpu.getEvent(&a, &g, &t);
  float accUp = a.acceleration.z;

  if (phase == PAD && !cand) {
    // learn "up" and the gyro bias while still (between 0.8 and 1.2 g)
    float m = sqrt(a.acceleration.x * a.acceleration.x + a.acceleration.y * a.acceleration.y + accUp * accUp);
    if (m > 0.8 * G && m < 1.2 * G) {
      upX += (a.acceleration.x / m - upX) * 0.02; upY += (a.acceleration.y / m - upY) * 0.02; upZ += (accUp / m - upZ) * 0.02;
      biasX += (g.gyro.x - biasX) * 0.02; biasY += (g.gyro.y - biasY) * 0.02; biasZ += (g.gyro.z - biasZ) * 0.02;
    }
  }
  if (attitudeOk) {
    integrateGyro(g.gyro.x - biasX, g.gyro.y - biasY, g.gyro.z - biasZ, dt);
    tiltDeg = tiltNow();
  }

  switch (phase) {
    case PAD:
      boostN = (accUp > 2.5 * G) ? boostN + 1 : 0;
      if (!cand && boostN >= 3) {
        cand = true; candMs = now; candAlt = alt;
        // start the attitude from the samples just before the push
        float n = sqrt(upX * upX + upY * upY + upZ * upZ);
        upX /= n; upY /= n; upZ /= n;
        qw = 1; qx = qy = qz = 0; attitudeOk = true;
      }
      if (cand) {
        if (alt - candAlt > 5 && vel > 10) { launchMs = candMs; maxAlt = alt; setPhase(BOOST); Serial.println(F("Launch")); }
        else if (now - candMs > 1500) { cand = false; attitudeOk = false; }
      }
      break;
    case BOOST:
      if (accUp < 0.5 * G && now - launchMs > 300) { burnoutMs = now; setPhase(STAGING); }
      break;
    case STAGING:
      if (now - burnoutMs >= IGNITE_DELAY_MS) {
        if (!attitudeOk) Serial.println(F("No attitude: sustainer held"));
        else if (tiltDeg > MAX_TILT_DEG) { Serial.print(F("Tilted ")); Serial.print(tiltDeg); Serial.println(F(" deg: sustainer held")); }
        else if (vel < MIN_LIGHT_VEL) Serial.println(F("Too slow: sustainer held"));
        else { fire(2); Serial.println(F("Sustainer lit")); }
        setPhase(COAST);
      }
      break;
    case COAST:
      belowN = (vel < 0) ? belowN + 1 : 0;
      if (now - launchMs > 3000 && (belowN >= 30 || (maxAlt - alt > 10 && vel < 0))) {
        apogeeMs = now;
        setPhase(DESCENT);
        Serial.println(F("Apogee"));
      }
      if (now - lastGoodBaro > 2000 && now - launchMs > 30000) { apogeeMs = now; setPhase(DESCENT); }
      break;
    case DESCENT:
      if (now - apogeeMs >= DROGUE_DELAY_MS) fire(0);
      if (alt < MAIN_ALT_M && vel < 0 && now - apogeeMs > 2000) { fire(1); setPhase(UNDER_MAIN); }
      break;
    case UNDER_MAIN:
      if (!(fired & 1) && now - apogeeMs >= DROGUE_DELAY_MS) fire(0);
      if (alt < 15 && fabs(vel) < 2) {
        if (!landMs) landMs = now;
        if (now - landMs > 3000) { setPhase(LANDED); Serial.println(F("Landed")); }
      } else landMs = 0;
      break;
    case LANDED:
      break;
  }
}
