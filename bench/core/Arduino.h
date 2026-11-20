// A stand-in Arduino core for running unmodified flight computer sketches on a
// PC, in lockstep with Mockingbird's simulation (see main.cpp).
//
// Time is virtual: it advances with delay(), a little with every loop() and
// every call to millis()/micros(), and with each sensor read, so a sketch runs
// as fast as the PC allows while seeing realistic timing. Pin writes, pin
// modes and servo positions go to the bench, which turns pyro pins into
// deployments and ignitions. Serial output goes to the run's console log.
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <stdarg.h>
#include <math.h>
#include <string>
#include <algorithm>

typedef uint8_t byte;
typedef bool boolean;
typedef unsigned int word;

#define HIGH 0x1
#define LOW 0x0
#define INPUT 0x0
#define OUTPUT 0x1
#define INPUT_PULLUP 0x2
#define INPUT_PULLDOWN 0x3
#define LED_BUILTIN 13
#define A0 14
#define A1 15
#define A2 16
#define A3 17
#define A4 18
#define A5 19
#define A6 20
#define A7 21
#define DEC 10
#define HEX 16
#define OCT 8
#define BIN 2
#define CHANGE 1
#define FALLING 2
#define RISING 3
#ifndef PI
#define PI 3.1415926535897932384626433832795
#endif
#define HALF_PI 1.5707963267948966192313216916398
#define TWO_PI 6.283185307179586476925286766559
#define DEG_TO_RAD 0.017453292519943295769236907684886
#define RAD_TO_DEG 57.295779513082320876798154814105
#define F(s) (s)
#define PSTR(s) (s)
#define PROGMEM
#define pgm_read_byte(p) (*(const uint8_t*)(p))
#define pgm_read_word(p) (*(const uint16_t*)(p))
#define pgm_read_float(p) (*(const float*)(p))
#define digitalPinToInterrupt(p) (p)
#define bitRead(v, b) (((v) >> (b)) & 0x01)
#define bitSet(v, b) ((v) |= (1UL << (b)))
#define bitClear(v, b) ((v) &= ~(1UL << (b)))
#define bitWrite(v, b, x) ((x) ? bitSet(v, b) : bitClear(v, b))
#define sq(x) ((x) * (x))
#define radians(d) ((d) * DEG_TO_RAD)
#define degrees(r) ((r) * RAD_TO_DEG)
#define noInterrupts()
#define interrupts()
#define yield()
typedef const char __FlashStringHelper;

using std::min;
using std::max;
template <class T, class L, class H> static inline T constrain(T x, L lo, H hi) { return x < (T)lo ? (T)lo : x > (T)hi ? (T)hi : x; }
static inline long map(long x, long a, long b, long c, long d) { return (x - a) * (d - c) / (b - a) + c; }

// ---- time and pins (main.cpp) ----
unsigned long millis();
unsigned long micros();
void delay(unsigned long ms);
void delayMicroseconds(unsigned int us);
void pinMode(uint8_t pin, uint8_t mode);
void digitalWrite(uint8_t pin, uint8_t val);
int digitalRead(uint8_t pin);
int analogRead(uint8_t pin);
void analogWrite(uint8_t pin, int val);
void analogReadResolution(int bits);
void tone(uint8_t pin, unsigned int freq, unsigned long dur = 0);
void noTone(uint8_t pin);
void attachInterrupt(uint8_t, void (*)(), int);
void detachInterrupt(uint8_t);
long random(long hi);
long random(long lo, long hi);
void randomSeed(unsigned long);

// The latest simulated sensor values (main.cpp). Reading them brings the
// simulation up to the board's current time.
namespace bench {
struct Sample { double p, temp, ax, ay, az, gx, gy, gz, lat, lon, galt; int arm; };
const Sample& sample();
void cost(uint32_t us);          // time a sensor read takes
void servo(uint8_t pin, float deg);
}

// ---- strings ----
class String {
 public:
  std::string s;
  String() {}
  String(const char* c) : s(c ? c : "") {}
  String(const std::string& x) : s(x) {}
  String(char c) : s(1, c) {}
  String(int v, int base = DEC) { fromLong(v, base); }
  String(unsigned int v, int base = DEC) { fromULong(v, base); }
  String(long v, int base = DEC) { fromLong(v, base); }
  String(unsigned long v, int base = DEC) { fromULong(v, base); }
  String(float v, int d = 2) { fromDouble(v, d); }
  String(double v, int d = 2) { fromDouble(v, d); }
  const char* c_str() const { return s.c_str(); }
  unsigned int length() const { return (unsigned int)s.size(); }
  String& operator+=(const String& o) { s += o.s; return *this; }
  String& operator+=(const char* o) { s += o ? o : ""; return *this; }
  String& operator+=(char c) { s += c; return *this; }
  String& operator+=(int v) { return *this += String(v); }
  String& operator+=(long v) { return *this += String(v); }
  String& operator+=(unsigned long v) { return *this += String(v); }
  String& operator+=(float v) { return *this += String(v); }
  String& operator+=(double v) { return *this += String(v); }
  bool concat(const String& o) { s += o.s; return true; }
  bool operator==(const String& o) const { return s == o.s; }
  bool operator==(const char* o) const { return s == (o ? o : ""); }
  bool operator!=(const String& o) const { return s != o.s; }
  char operator[](unsigned int i) const { return i < s.size() ? s[i] : 0; }
  char charAt(unsigned int i) const { return (*this)[i]; }
  int indexOf(char c) const { auto p = s.find(c); return p == std::string::npos ? -1 : (int)p; }
  int indexOf(const String& c) const { auto p = s.find(c.s); return p == std::string::npos ? -1 : (int)p; }
  String substring(unsigned int a) const { return a < s.size() ? String(s.substr(a)) : String(); }
  String substring(unsigned int a, unsigned int b) const { return a < s.size() && b > a ? String(s.substr(a, b - a)) : String(); }
  long toInt() const { return atol(s.c_str()); }
  float toFloat() const { return (float)atof(s.c_str()); }
  void trim() { while (!s.empty() && isspace((unsigned char)s.back())) s.pop_back(); size_t i = 0; while (i < s.size() && isspace((unsigned char)s[i])) i++; s.erase(0, i); }
  void toUpperCase() { for (auto& c : s) c = (char)toupper(c); }
  void toLowerCase() { for (auto& c : s) c = (char)tolower(c); }
  bool startsWith(const String& p) const { return s.rfind(p.s, 0) == 0; }
  bool endsWith(const String& p) const { return s.size() >= p.s.size() && s.compare(s.size() - p.s.size(), p.s.size(), p.s) == 0; }
  void reserve(unsigned int n) { s.reserve(n); }
  void remove(unsigned int i, unsigned int n = 1) { if (i < s.size()) s.erase(i, n); }
  void replace(const String& a, const String& b) { if (a.s.empty()) return; size_t p = 0; while ((p = s.find(a.s, p)) != std::string::npos) { s.replace(p, a.s.size(), b.s); p += b.s.size(); } }
 private:
  void fromLong(long v, int base) { if (base == DEC) s = std::to_string(v); else fromULong((unsigned long)v, base); }
  void fromULong(unsigned long v, int base) {
    if (base == DEC) { s = std::to_string(v); return; }
    char buf[70]; int i = 68; buf[69] = 0; if (!v) buf[i--] = '0';
    while (v) { int d = (int)(v % base); buf[i--] = (char)(d < 10 ? '0' + d : 'A' + d - 10); v /= base; }
    s = buf + i + 1;
  }
  void fromDouble(double v, int d) { char b[64]; snprintf(b, sizeof b, "%.*f", d, v); s = b; }
};
inline String operator+(const String& a, const String& b) { String r(a); r += b; return r; }
inline String operator+(const String& a, const char* b) { String r(a); r += b; return r; }
inline String operator+(const char* a, const String& b) { String r(a); r += b; return r; }
inline String operator+(const String& a, char b) { String r(a); r += b; return r; }
inline String operator+(const String& a, int b) { String r(a); r += String(b); return r; }
inline String operator+(const String& a, long b) { String r(a); r += String(b); return r; }
inline String operator+(const String& a, unsigned long b) { String r(a); r += String(b); return r; }
inline String operator+(const String& a, unsigned int b) { String r(a); r += String(b); return r; }
inline String operator+(const String& a, float b) { String r(a); r += String(b); return r; }
inline String operator+(const String& a, double b) { String r(a); r += String(b); return r; }

// dtostrf, as on AVR
static inline char* dtostrf(double v, signed char width, unsigned char prec, char* out) { sprintf(out, "%*.*f", width, prec, v); return out; }

// ---- printing ----
class Print {
 public:
  virtual ~Print() {}
  virtual size_t write(uint8_t c) = 0;
  virtual size_t write(const uint8_t* b, size_t n) { size_t k = 0; while (n--) k += write(*b++); return k; }
  size_t write(const char* s) { return s ? write((const uint8_t*)s, strlen(s)) : 0; }
  virtual void flush() {}
  size_t print(const char* s) { return write(s); }
  size_t print(const String& s) { return write(s.c_str()); }
  size_t print(char c) { return write((uint8_t)c); }
  size_t print(unsigned char v, int base = DEC) { return print((unsigned long)v, base); }
  size_t print(int v, int base = DEC) { return print((long)v, base); }
  size_t print(unsigned int v, int base = DEC) { return print((unsigned long)v, base); }
  size_t print(long v, int base = DEC) { return write(String(v, base).c_str()); }
  size_t print(unsigned long v, int base = DEC) { return write(String(v, base).c_str()); }
  size_t print(long long v, int base = DEC) { return print((long)v, base); }
  size_t print(unsigned long long v, int base = DEC) { return print((unsigned long)v, base); }
  size_t print(double v, int d = 2) { if (isnan(v)) return write("nan"); if (isinf(v)) return write("inf"); return write(String(v, d).c_str()); }
  size_t print(float v, int d = 2) { return print((double)v, d); }
  size_t print(bool v) { return print((int)v); }
  template <class T> size_t println(T v) { size_t n = print(v); return n + write("\r\n"); }
  template <class T> size_t println(T v, int b) { size_t n = print(v, b); return n + write("\r\n"); }
  size_t println() { return write("\r\n"); }
  int printf(const char* fmt, ...) { char b[512]; va_list a; va_start(a, fmt); int n = vsnprintf(b, sizeof b, fmt, a); va_end(a); write(b); return n; }
};

class Stream : public Print {
 public:
  virtual int available() { return 0; }
  virtual int read() { return -1; }
  virtual int peek() { return -1; }
  void setTimeout(unsigned long) {}
  String readStringUntil(char) { return String(); }
  String readString() { return String(); }
  float parseFloat() { return 0; }
  long parseInt() { return 0; }
};

// Serial: everything printed goes to the run's console log.
class HardwareSerial : public Stream {
 public:
  void begin(unsigned long, int = 0) {}
  void end() {}
  operator bool() const { return true; }
  size_t write(uint8_t c) override;
  using Print::write;
  void flush() override;
};
extern HardwareSerial Serial;
extern HardwareSerial Serial1;
extern HardwareSerial Serial2;

void setup();
void loop();
