// Stand-in SD card: files open and accept writes, which are counted, not kept.
#pragma once
#include "Arduino.h"
#include "SPI.h"
#define FILE_READ 0
#define FILE_WRITE 1
#define O_READ 0
#define O_WRITE 1
#define O_CREAT 2
#define O_APPEND 4
class File : public Stream {
  bool ok_ = false; size_t n_ = 0;
 public:
  File() {}
  explicit File(bool ok) : ok_(ok) {}
  size_t write(uint8_t) override { if (!ok_) return 0; n_++; bench::cost(2); return 1; }
  size_t write(const uint8_t* b, size_t n) override { (void)b; if (!ok_) return 0; n_ += n; bench::cost(2 * (uint32_t)n); return n; }
  using Print::write;
  void flush() override { bench::cost(3000); }
  void close() { flush(); ok_ = false; }
  size_t size() { return n_; }
  bool seek(uint32_t) { return true; }
  const char* name() { return "file"; }
  operator bool() const { return ok_; }
};
class SDClass {
 public:
  bool begin(uint8_t = 0) { return true; }
  bool begin(uint8_t, SPIClass&) { return true; }
  File open(const char*, uint8_t = FILE_READ) { return File(true); }
  File open(const String& s, uint8_t m = FILE_READ) { return open(s.c_str(), m); }
  bool exists(const char*) { return false; }
  bool exists(const String&) { return false; }
  bool remove(const char*) { return true; }
  bool mkdir(const char*) { return true; }
};
inline SDClass SD;
