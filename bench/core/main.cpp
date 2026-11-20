// The virtual board: runs an Arduino sketch in lockstep with the bench.
//
// stdin/stdout carry the lockstep protocol, one line each way:
//   board → bench  B                      booted (also after a restart)
//                  P <pin> <0|1> <us>     a pin changed (digitalWrite)
//                  M <pin> <mode> <us>    pinMode
//                  S <pin> <deg> <us>     servo position
//                  T <us>                 "it's now <us>; what do the sensors say?"
//   bench → board  C <us>                 the clock to start from (after B)
//                  D <us> p temp ax ay az gx gy gz lat lon galt arm
//                  R                      restart now (power blip)
//                  E                      the test is over: exit
// File descriptor 3, when open, gets everything the sketch prints on Serial.
// BENCH_EEPROM names a file that stands in for EEPROM, kept across restarts.
#include "Arduino.h"
#include <unistd.h>
#include <string>

HardwareSerial Serial, Serial1, Serial2;

// g_us is the bench clock (it runs on across a restart); the sketch sees time
// since its own boot, as millis() on a real board starts again from 0.
static uint64_t g_us = 0, g_lastSync = 0, g_boot = 0;
static const uint64_t SYNC_US = 4000;       // sensors refresh at least this often when read
static const uint32_t LOOP_COST_US = 200;   // one pass through loop()
static bench::Sample g_s = {101325, 15, 0, 0, 9.80665, 0, 0, 0, 0, 0, 0, 1};
static std::string g_pending;
static uint8_t g_pin[256], g_mode[256];
static FILE* g_console = nullptr;
static char** g_argv = nullptr;

static void restartNow() {
  fflush(stdout);
  if (g_console) fflush(g_console);
  execv("/proc/self/exe", g_argv);
  _exit(3);
}

static bool readLine(std::string& out) {
  out.clear();
  int c;
  while ((c = fgetc(stdin)) != EOF) { if (c == '\n') return true; out += (char)c; }
  return !out.empty();
}

// Tell the bench what changed and get the sensors for now.
static void boardSync() {
  char buf[64];
  snprintf(buf, sizeof buf, "T %llu\n", (unsigned long long)g_us);
  g_pending += buf;
  fputs(g_pending.c_str(), stdout);
  fflush(stdout);
  g_pending.clear();
  g_lastSync = g_us;
  std::string line;
  if (!readLine(line)) _exit(0);
  if (line[0] == 'E') { if (g_console) fflush(g_console); _exit(0); }
  if (line[0] == 'R') restartNow();
  if (line[0] == 'D') {
    unsigned long long t; double v[11]; int arm = 1;
    if (sscanf(line.c_str() + 1, "%llu %lf %lf %lf %lf %lf %lf %lf %lf %lf %lf %lf %d", &t, &v[0], &v[1], &v[2], &v[3], &v[4], &v[5], &v[6], &v[7], &v[8], &v[9], &v[10], &arm) >= 12) {
      g_s = {v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], v[9], v[10], arm};
    }
  }
}
static inline void maybeSync() { if (g_us - g_lastSync >= SYNC_US) boardSync(); }

namespace bench {
const Sample& sample() { maybeSync(); return g_s; }
void cost(uint32_t us) { g_us += us; }
void servo(uint8_t pin, float deg) {
  char buf[64];
  snprintf(buf, sizeof buf, "S %u %.2f %llu\n", pin, deg, (unsigned long long)g_us);
  g_pending += buf;
  boardSync();
}
}

unsigned long millis() { g_us += 2; maybeSync(); return (unsigned long)((g_us - g_boot) / 1000); }
unsigned long micros() { g_us += 2; maybeSync(); return (unsigned long)(g_us - g_boot); }
void delay(unsigned long ms) {
  uint64_t end = g_us + (uint64_t)ms * 1000;
  while (g_us < end) { uint64_t step = std::min<uint64_t>(end - g_us, SYNC_US); g_us += step; maybeSync(); }
}
void delayMicroseconds(unsigned int us) { g_us += us; maybeSync(); }

void pinMode(uint8_t pin, uint8_t mode) {
  if (g_mode[pin] == mode + 1) return;
  g_mode[pin] = mode + 1;
  char buf[64];
  snprintf(buf, sizeof buf, "M %u %u %llu\n", pin, mode, (unsigned long long)g_us);
  g_pending += buf;
}
void digitalWrite(uint8_t pin, uint8_t val) {
  val = val ? 1 : 0;
  if (g_pin[pin] == val) return;
  g_pin[pin] = val;
  char buf[64];
  snprintf(buf, sizeof buf, "P %u %u %llu\n", pin, val, (unsigned long long)g_us);
  g_pending += buf;
  boardSync();   // a pyro channel acts at once
}
// The arm switch (if the task has one) reads from the bench; other inputs read
// back what was written, or HIGH with a pull-up.
static int g_armPin = -1, g_armedLevel = 0;
int digitalRead(uint8_t pin) {
  g_us += 2;
  if ((int)pin == g_armPin) { maybeSync(); return g_s.arm ? g_armedLevel : !g_armedLevel; }
  if (g_mode[pin] == INPUT_PULLUP + 1) return HIGH;
  return g_pin[pin];
}
int analogRead(uint8_t) { g_us += 100; return 512; }
void analogWrite(uint8_t pin, int val) { digitalWrite(pin, val > 127); }
void analogReadResolution(int) {}
void tone(uint8_t, unsigned int, unsigned long) {}
void noTone(uint8_t) {}
void attachInterrupt(uint8_t, void (*)(), int) {}
void detachInterrupt(uint8_t) {}
long random(long hi) { return hi > 0 ? rand() % hi : 0; }
long random(long lo, long hi) { return hi > lo ? lo + rand() % (hi - lo) : lo; }
void randomSeed(unsigned long s) { srand((unsigned)s); }

size_t HardwareSerial::write(uint8_t c) { if (g_console) fputc(c, g_console); return 1; }
void HardwareSerial::flush() { if (g_console) fflush(g_console); }

int main(int, char** argv) {
  g_argv = argv;
  g_console = fdopen(3, "a");
  if (const char* a = getenv("BENCH_ARM_PIN")) g_armPin = atoi(a);
  if (const char* l = getenv("BENCH_ARMED_LEVEL")) g_armedLevel = atoi(l);
  fputs("B\n", stdout);
  fflush(stdout);
  std::string line;
  if (!readLine(line) || line[0] != 'C') return 2;
  g_us = g_lastSync = g_boot = strtoull(line.c_str() + 2, nullptr, 10);
  boardSync();
  setup();
  for (;;) { loop(); g_us += LOOP_COST_US; maybeSync(); }
}
