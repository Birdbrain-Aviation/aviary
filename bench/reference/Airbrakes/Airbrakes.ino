// Reference airbrakes flight computer for the bench's "airbrakes" task: dual
// deploy plus airbrakes steering to a target apogee. Plain Arduino and the
// real Adafruit libraries; meets prompt-safety.md.
//
// Hardware: BMP390, MPU6050 (Z to the nose), drogue pin 5, main pin 6, arm
// switch pin 7 (LOW = armed), airbrake servo pin 9 (0° shut, 90° open).
//
// Altitude and vertical speed come from the accelerometer, corrected by the
// barometer (a barometer-only filter lags too much to steer by). After burnout
// it predicts the apogee with the brakes shut and fully open, and sets the
// brakes in between so the prediction lands on the target.

#include <Wire.h>
#include <EEPROM.h>
#include <Servo.h>
#include <Adafruit_BMP3XX.h>
#include <Adafruit_MPU6050.h>

const uint8_t PIN_DROGUE = 5, PIN_MAIN = 6, PIN_ARM = 7, PIN_SERVO = 9;
const float MAIN_ALT_M = 152.4;
const uint32_t DROGUE_DELAY_MS = 1000;
const uint32_t PULSE_MS = 1000;
const uint32_t SAMPLE_MS = 10;
const float G = 9.80665;
const float TARGET_M = 518.2;             // 1,700 ft
const float MASS_KG = 0.86;               // after burnout
const float CDA_BODY = 0.5 * 0.0022902;   // Cd × area, 54 mm body
const float CDA_BRAKE = 1.2 * 0.0040;     // Cd × area, brakes fully open
const float SERVO_SHUT = 0, SERVO_OPEN = 90;
const float BRAKE_MIN_VEL = 8;            // shut the brakes below this, ahead of apogee

Adafruit_BMP3XX bmp;
Adafruit_MPU6050 mpu;
Servo brake;

enum Phase : uint8_t { PAD, BOOST, COAST, DESCENT, UNDER_MAIN, LANDED };
Phase phase = PAD;

struct Saved { uint16_t magic; uint8_t phase; uint8_t fired; float p0; float tPad; };
const uint16_t MAGIC = 0xB1D7;
Saved saved;

float p0 = 0, tPad = 15, accPad = G;
float alt = 0, vel = 0, maxAlt = 0;
bool filterSeeded = false;
uint16_t padN = 0;
uint32_t lastSample = 0, launchMs = 0, candMs = 0, apogeeMs = 0, landMs = 0, lastGoodBaro = 0, burnoutMs = 0;
bool cand = false;
float candAlt = 0;
uint8_t boostN = 0, belowN = 0, rejectN = 0;
uint8_t fired = 0;
uint32_t offAt[2] = {0, 0};
const uint8_t PYRO[2] = {PIN_DROGUE, PIN_MAIN};
float brakeCmd = 0;
uint32_t restartMs = 0;                  // when it restarted in flight (0: it didn't)
bool settling() { return restartMs && millis() - restartMs < 1000; }

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

void setBrake(float frac) {
  frac = constrain(frac, 0.0, 1.0);
  brakeCmd = frac;
  brake.write((int)lroundf(SERVO_SHUT + frac * (SERVO_OPEN - SERVO_SHUT)));
}

// Height still to gain coasting up at speed v with drag k = ½ρ·CdA.
float coastGain(float v, float cda) {
  float rho = (p0 > 0 ? p0 : 101325) / (287.05 * (273.15 + tPad)) * exp(-alt / 8500.0);
  float k = 0.5 * rho * cda;
  return MASS_KG / (2 * k) * log(1 + k * v * v / (MASS_KG * G));
}

void setup() {
  for (uint8_t i = 0; i < 2; i++) { digitalWrite(PYRO[i], LOW); pinMode(PYRO[i], OUTPUT); }
  pinMode(PIN_ARM, INPUT_PULLUP);
  brake.write((int)SERVO_SHUT);           // before attach, so it starts shut
  brake.attach(PIN_SERVO);
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
    burnoutMs = millis() - 1000;
    apogeeMs = millis() - DROGUE_DELAY_MS;
    if (phase == BOOST) phase = COAST;     // can't know how much burn is left: steer only once it's clearly coasting
    restartMs = millis() | 1;              // the speed estimate starts from scratch: let it settle before steering
    Serial.println(F("Restarted in flight: carrying on"));
  } else {
    saved.magic = 0;
    EEPROM.put(0, saved);
  }
}

void loop() {
  uint32_t now = millis();
  for (uint8_t i = 0; i < 2; i++) if (offAt[i] && (int32_t)(now - offAt[i]) >= 0) { digitalWrite(PYRO[i], LOW); offAt[i] = 0; }
  if (now - lastSample < SAMPLE_MS) return;
  float dt = lastSample ? (now - lastSample) / 1000.0 : SAMPLE_MS / 1000.0;
  lastSample = now;

  sensors_event_t a, g, t;
  mpu.getEvent(&a, &g, &t);
  float accUp = a.acceleration.z;

  bool baroOk = bmp.performReading();
  if (baroOk && phase == PAD) {
    padN++;
    float k = 1.0 / min((int)padN, 200);
    p0 = (p0 == 0) ? bmp.pressure : p0 + (bmp.pressure - p0) * k;
    tPad = tPad + (bmp.temperature - tPad) * k;
    if (!cand && accUp > 0.85 * G && accUp < 1.15 * G) accPad += (accUp - accPad) * k;   // 1 g as this sensor reads it
  }

  // predict with the accelerometer once flying (on the pad it is just gravity)
  bool flying = phase != PAD || cand;
  float acc = flying ? (accUp - accPad) : 0;
  if (phase >= DESCENT) acc = 0;           // under a parachute the rocket swings: don't trust it
  float pred = alt + vel * dt + 0.5 * acc * dt * dt;
  vel += acc * dt;
  alt = pred;
  if (baroOk && p0 > 0) {
    lastGoodBaro = now;
    float h = 44330.77 * ((273.15 + tPad) / 288.15) * (1.0 - pow(bmp.pressure / p0, 0.190263));
    if (!filterSeeded) { alt = h; vel = 0; filterSeeded = true; pred = h; }
    float r = h - pred;
    if (fabs(r) > 20) { if (++rejectN < 100) r = 0; else { alt = h; rejectN = 0; r = 0; } }
    else rejectN = 0;
    bool slow = flying && phase < DESCENT && !settling();
    float ka = slow ? 0.02 : 0.15, kv = slow ? 0.002 : 0.015;
    alt += ka * r;
    vel += kv * r / dt;
  }
  if (alt > maxAlt && phase != PAD) maxAlt = alt;

  switch (phase) {
    case PAD:
      boostN = (accUp > 2.5 * G) ? boostN + 1 : 0;
      if (!cand && boostN >= 3) { cand = true; candMs = now; candAlt = alt; }
      if (cand) {
        if (alt - candAlt > 5 && vel > 10) { launchMs = candMs; maxAlt = alt; setPhase(BOOST); Serial.println(F("Launch")); }
        else if (now - candMs > 1500) { cand = false; vel = 0; }
      }
      break;
    case BOOST:
      setBrake(0);
      if (accUp < 0.5 * G && now - launchMs > 300) { burnoutMs = now; setPhase(COAST); }
      break;
    case COAST: {
      // steer once the motor is clearly out, and shut again near apogee
      if (settling()) setBrake(0);
      else if (now - burnoutMs > 200 && accUp < 0 && vel > BRAKE_MIN_VEL) {
        float shut = alt + coastGain(vel, CDA_BODY);
        float open = alt + coastGain(vel, CDA_BODY + CDA_BRAKE);
        setBrake(shut - open > 1 ? (shut - TARGET_M) / (shut - open) : 0);
      } else if (vel <= BRAKE_MIN_VEL) setBrake(0);
      belowN = (vel < 0) ? belowN + 1 : 0;
      if (now - launchMs > 3000 && (belowN >= 30 || (maxAlt - alt > 10 && vel < 0))) {
        setBrake(0);
        apogeeMs = now;
        setPhase(DESCENT);
        Serial.print(F("Apogee "));
        Serial.println(maxAlt);
      }
      if (now - lastGoodBaro > 2000 && now - launchMs > 16000) { setBrake(0); apogeeMs = now; setPhase(DESCENT); }
      break;
    }
    case DESCENT:
      setBrake(0);
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
