// Runs an Arduino sketch on a PC: setup() once, then loop() until stdin closes.
// A restart re-runs the program in place (execv), so all of the sketch's
// variables start over while the "USB cable" (stdin/stdout) stays connected.
#include "Arduino.h"
#include <chrono>
#include <thread>

StdioSerial Serial;
int g_pinWrites = 0;
static const auto T0 = std::chrono::steady_clock::now();
uint32_t millis() { return (uint32_t)std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - T0).count(); }
uint32_t micros() { return (uint32_t)std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - T0).count(); }
void delay(uint32_t ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }

static char** g_argv = nullptr;
void mbNativeRestart() {
  fflush(stdout);
  fprintf(stderr, "restarting\n");
  execv("/proc/self/exe", g_argv);
  _exit(3);
}

#include SKETCH

int main(int argc, char** argv) {
  (void)argc;
  g_argv = argv;
  setup();
  for (;;) {
    loop();
    if (Serial.closed()) break;
    if (!Serial.available()) std::this_thread::sleep_for(std::chrono::microseconds(150));
  }
  fprintf(stderr, "pin writes: %d\n", g_pinWrites);
  return 0;
}
