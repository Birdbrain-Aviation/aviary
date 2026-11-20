// Stand-in EEPROM, kept in the file BENCH_EEPROM so it survives a restart test
// (and starts erased, 0xFF, for each new test).
#pragma once
#include "Arduino.h"
class EEPROMClass {
  uint8_t d_[4096];
  bool loaded_ = false;
  void load() {
    if (loaded_) return;
    loaded_ = true;
    memset(d_, 0xFF, sizeof d_);
    if (const char* p = getenv("BENCH_EEPROM")) { if (FILE* f = fopen(p, "rb")) { size_t n = fread(d_, 1, sizeof d_, f); (void)n; fclose(f); } }
  }
  void save() { if (const char* p = getenv("BENCH_EEPROM")) { if (FILE* f = fopen(p, "wb")) { fwrite(d_, 1, sizeof d_, f); fclose(f); } } }
 public:
  struct Ref {
    EEPROMClass* e; int i;
    operator uint8_t() const { return e->read(i); }
    Ref& operator=(uint8_t v) { e->write(i, v); return *this; }
    Ref& operator=(const Ref& r) { e->write(i, (uint8_t)r); return *this; }
  };
  void begin(size_t = 0) { load(); }
  bool commit() { save(); return true; }
  void end() { save(); }
  uint16_t length() { return sizeof d_; }
  uint8_t read(int i) { load(); return i >= 0 && i < (int)sizeof d_ ? d_[i] : 0; }
  void write(int i, uint8_t v) { load(); if (i >= 0 && i < (int)sizeof d_) { d_[i] = v; save(); } }
  void update(int i, uint8_t v) { if (read(i) != v) write(i, v); }
  Ref operator[](int i) { return Ref{this, i}; }
  template <class T> T& get(int i, T& t) { load(); if (i >= 0 && i + sizeof(T) <= sizeof d_) memcpy((void*)&t, d_ + i, sizeof(T)); return t; }
  template <class T> const T& put(int i, const T& t) { load(); if (i >= 0 && i + sizeof(T) <= sizeof d_) { memcpy(d_ + i, (const void*)&t, sizeof(T)); save(); } return t; }
};
inline EEPROMClass EEPROM;
