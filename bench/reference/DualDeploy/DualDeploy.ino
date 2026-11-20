// Reference dual-deploy flight computer for the bench's "dual-deploy" task:
// written the way a careful person would, against the real Adafruit libraries
// and plain Arduino calls (no Mockingbird library). It meets every requirement
// in prompt-safety.md and is the starting point for planted-bug testing.
//
// Hardware: BMP390 (Adafruit_BMP3XX), MPU6050 (Adafruit_MPU6050, Z to the
// nose), drogue on pin 5, main on pin 6, arm switch on pin 7 (LOW = armed).

#include <Wire.h>
#include <EEPROM.h>
#include <Adafruit_BMP3XX.h>
#include <Adafruit_MPU6050.h>

const uint8_t PIN_DROGUE = 5;
const uint8_t PIN_MAIN = 6;
const uint8_t PIN_ARM = 7;
const float MAIN_ALT_M = 152.4;          // 500 ft
const uint32_t DROGUE_DELAY_MS = 1000;
const uint32_t PULSE_MS = 1000;          // how long a channel stays on
const uint32_t SAMPLE_MS = 10;           // 100 Hz
const float G = 9.80665;

Adafruit_BMP3XX bmp;
Adafruit_MPU6050 mpu;

enum Phase : uint8_t { PAD, BOOST, COAST, DESCENT, UNDER_MAIN, LANDED };
Phase phase = PAD;

// What a restart must not forget, kept in EEPROM.
struct Saved {
  uint16_t magic;
  uint8_t phase;
  uint8_t fired;          // bit 0 drogue, bit 1 main
  float p0;               // ground pressure, Pa
  float tPad;             // ground temperature, °C
};
const uint16_t MAGIC = 0xB1D5;
Saved saved;

float p0 = 0, tPad = 15;
float alt = 0, vel = 0, maxAlt = 0;
bool filterSeeded = false;
uint16_t padN = 0;
uint32_t lastSample = 0, launchMs = 0, candMs = 0, apogeeMs = 0, landMs = 0, lastGoodBaro = 0;
bool cand = false;
float candAlt = 0;
uint8_t boostN = 0, belowN = 0, rejectN = 0;
uint8_t fired = 0;
uint32_t offAt[2] = {0, 0};               // when each channel switches off (0 = off)
const uint8_t PYRO[2] = {PIN_DROGUE, PIN_MAIN};

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

void setup() {
  // pyro outputs off before anything else
  for (uint8_t i = 0; i < 2; i++) { digitalWrite(PYRO[i], LOW); pinMode(PYRO[i], OUTPUT); }
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

  // carry on after a restart in flight
  EEPROM.get(0, saved);
  if (saved.magic == MAGIC && saved.phase != PAD && saved.phase != LANDED) {
    phase = (Phase)saved.phase;
    fired = saved.fired;
    p0 = saved.p0;
    tPad = saved.tPad;
    // millis() starts again from 0, so old times mean nothing: act as if launch
    // was long enough ago, and apogee one drogue delay ago (fire the drogue
    // now if it hasn't gone). Unsigned arithmetic makes these wrap correctly.
    launchMs = millis() - 3001;
    apogeeMs = millis() - DROGUE_DELAY_MS;
    filterSeeded = false;                  // start the filter where the rocket is
    Serial.println(F("Restarted in flight: carrying on"));
  } else {
    saved.magic = 0;
    EEPROM.put(0, saved);
  }
}

void loop() {
  uint32_t now = millis();
  // switch channels off after their pulse
  for (uint8_t i = 0; i < 2; i++) if (offAt[i] && (int32_t)(now - offAt[i]) >= 0) { digitalWrite(PYRO[i], LOW); offAt[i] = 0; }
  if (now - lastSample < SAMPLE_MS) return;
  float dt = lastSample ? (now - lastSample) / 1000.0 : SAMPLE_MS / 1000.0;
  lastSample = now;

  // barometer: altitude above the pad, corrected for the pad temperature
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
    // alpha-beta filter; ignore jumps no rocket could make in one sample, but
    // believe the barometer again if it stays away for a whole second
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
  float accUp = a.acceleration.z;            // m/s², +1 g on the pad

  switch (phase) {
    case PAD:
      // a launch candidate needs a sustained push, confirmed by climbing
      boostN = (accUp > 2.5 * G) ? boostN + 1 : 0;
      if (!cand && boostN >= 3) { cand = true; candMs = now; candAlt = alt; }
      if (cand) {
        if (alt - candAlt > 5 && vel > 10) { launchMs = candMs; maxAlt = alt; setPhase(BOOST); Serial.println(F("Launch")); }
        else if (now - candMs > 1500) cand = false;   // a bump, not a launch
      }
      break;
    case BOOST:
      if (accUp < 0.5 * G && now - launchMs > 300) setPhase(COAST);
      break;
    case COAST:
      // apogee: falling for 0.3 s, or 10 m below the highest point
      belowN = (vel < 0) ? belowN + 1 : 0;
      if (now - launchMs > 3000 && (belowN >= 30 || (maxAlt - alt > 10 && vel < 0))) {
        apogeeMs = now;
        setPhase(DESCENT);
        Serial.println(F("Apogee"));
      }
      // barometer dead or frozen: fall back to a timer well after the expected apogee
      if (now - lastGoodBaro > 2000 && now - launchMs > 16000) { apogeeMs = now; setPhase(DESCENT); }
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
