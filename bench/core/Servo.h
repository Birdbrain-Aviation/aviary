// Stand-in Servo: positions go to the bench (an airbrake servo, a gimbal...).
// As with the real library, attach() starts the pulses at once at the last
// value written, or 1500 µs (90°) if nothing was: write() before attach() to
// start somewhere else.
#pragma once
#include "Arduino.h"
class Servo {
  int pin_ = -1, min_ = 544, max_ = 2400; float deg_ = 90, sent_ = -1;
  // tell the bench only when the position changes
  void send() { if (pin_ >= 0 && deg_ != sent_) { sent_ = deg_; bench::servo((uint8_t)pin_, deg_); } }
 public:
  uint8_t attach(int pin, int mn = 544, int mx = 2400) { pin_ = pin; min_ = mn; max_ = mx; sent_ = -1; send(); return 1; }
  void detach() { pin_ = -1; }
  bool attached() { return pin_ >= 0; }
  void write(int v) {
    if (v >= 544) { writeMicroseconds(v); return; }      // like the real library: values from MIN_PULSE_WIDTH up are microseconds
    deg_ = (float)constrain(v, 0, 180);
    send();
  }
  void writeMicroseconds(int us) {
    deg_ = 180.0f * (float)(constrain(us, min_, max_) - min_) / (float)(max_ - min_);
    send();
  }
  int read() { return (int)lroundf(deg_); }
  int readMicroseconds() { return (int)(min_ + deg_ / 180.0f * (max_ - min_)); }
};
