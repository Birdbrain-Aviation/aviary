// A tiny stand-in for the Arduino core so the MockingbirdHIL library and its
// examples compile and run on a PC. Serial is stdin/stdout (non-blocking).
#pragma once
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <cstdio>
#include <cmath>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>

using std::isnan;
using std::fabs;
using std::pow;

class __FlashStringHelper;
#define F(s) (reinterpret_cast<const __FlashStringHelper*>(s))
#define PROGMEM
#define HIGH 1
#define LOW 0
#define OUTPUT 1
#define INPUT 0

uint32_t millis();
uint32_t micros();
void delay(uint32_t ms);
inline void pinMode(int, int) {}
extern int g_pinWrites;
inline void digitalWrite(int, int) { g_pinWrites++; }

class Print {
 public:
  virtual ~Print() {}
  virtual size_t write(uint8_t c) = 0;
  size_t print(const char* s) { size_t n = 0; while (*s) n += write((uint8_t)*s++); return n; }
  size_t print(const __FlashStringHelper* s) { return print(reinterpret_cast<const char*>(s)); }
  size_t print(char c) { return write((uint8_t)c); }
  size_t print(unsigned char v) { return fmt("%u", (unsigned)v); }
  size_t print(int v) { return fmt("%d", v); }
  size_t print(unsigned int v) { return fmt("%u", v); }
  size_t print(long v) { return fmt("%ld", v); }
  size_t print(unsigned long v) { return fmt("%lu", v); }
  size_t print(double v, int digits = 2) {
    if (std::isnan(v)) return print("nan");
    if (std::isinf(v)) return print("inf");
    char b[48]; snprintf(b, sizeof b, "%.*f", digits, v); return print(b);
  }
  size_t println() { return print("\r\n"); }
  template <typename T> size_t println(T v) { size_t n = print(v); return n + println(); }
  size_t println(double v, int digits) { size_t n = print(v, digits); return n + println(); }

 private:
  template <typename T> size_t fmt(const char* f, T v) { char b[32]; snprintf(b, sizeof b, f, v); return print(b); }
};

class Stream : public Print {
 public:
  virtual int available() = 0;
  virtual int read() = 0;
};

class StdioSerial : public Stream {
 public:
  void begin(long) { fcntl(0, F_SETFL, fcntl(0, F_GETFL) | O_NONBLOCK); }
  int available() override { fill(); return n_ - i_; }
  int read() override { fill(); return i_ < n_ ? (unsigned char)buf_[i_++] : -1; }
  size_t write(uint8_t c) override { fputc(c, stdout); if (c == '\n') fflush(stdout); return 1; }
  bool closed() const { return eof_ && i_ >= n_; }
  explicit operator bool() const { return true; }

 private:
  void fill() {
    if (i_ < n_ || eof_) return;
    ssize_t r = ::read(0, buf_, sizeof buf_);
    if (r > 0) { n_ = (int)r; i_ = 0; } else if (r == 0) eof_ = true;
  }
  char buf_[64];   // the same size as an Arduino Uno's receive buffer
  int n_ = 0, i_ = 0;
  bool eof_ = false;
};

extern StdioSerial Serial;
