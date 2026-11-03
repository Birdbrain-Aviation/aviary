#include "MockingbirdHIL.h"
#include <string.h>
#include <stdlib.h>
#include <math.h>

// Field names in the order of MockingbirdHIL::Field (starting at T_MS = 1).
#if defined(__AVR__)
#include <avr/pgmspace.h>
#define MB_RB(p) pgm_read_byte(p)
static const char MB_NAMES[] PROGMEM = "t_ms,p_pa,temp_c,alt_m,vz,ax,ay,az,ax_g,ay_g,az_g,gx,gy,gz,lat,lon,gps_alt,sats";
#else
#define MB_RB(p) (*(const char*)(p))
static const char MB_NAMES[] = "t_ms,p_pa,temp_c,alt_m,vz,ax,ay,az,ax_g,ay_g,az_g,gx,gy,gz,lat,lon,gps_alt,sats";
#endif

static const float MB_G = 9.80665f;

static uint8_t mbFieldId(const char* name) {
  uint8_t id = 1;
  const char* p = MB_NAMES;
  for (;;) {
    const char* q = name;
    char c;
    while ((c = MB_RB(p)) != 0 && c != ',' && c == *q) { p++; q++; }
    if ((c == ',' || c == 0) && *q == 0) return id;
    while ((c = MB_RB(p)) != 0 && c != ',') p++;
    if (!c) return 0;
    p++;
    id++;
  }
}

static int mbHex(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}

// "40.8500123" -> 408500123 (degrees x 10^7) without floating point.
static int32_t mbParseE7(const char* s, bool* ok) {
  while (*s == ' ') s++;
  bool neg = false;
  if (*s == '-') { neg = true; s++; } else if (*s == '+') s++;
  if (!*s) { *ok = false; return 0; }
  int32_t ip = 0, fp = 0;
  uint8_t nd = 0;
  while (*s >= '0' && *s <= '9') { ip = ip * 10 + (*s - '0'); s++; }
  if (*s == '.') {
    s++;
    while (*s >= '0' && *s <= '9') { if (nd < 7) { fp = fp * 10 + (*s - '0'); nd++; } s++; }
  }
  while (nd < 7) { fp *= 10; nd++; }
  *ok = true;
  int32_t v = ip * 10000000L + fp;
  return neg ? -v : v;
}

MockingbirdHIL::MockingbirdHIL(Stream& port)
    : _port(port), _name("flight computer"), _len(0), _overflow(false), _active(false), _started(false), _ended(false),
      _ncols(0), _latE7(0), _lonE7(0), _tms(0), _rxAt(0), _rxUs(0), _lastRx(0), _lastStats(0), _lastClock(0),
      _rate(50), _scale(1.0f), _good(0), _bad(0) {
  memset(_map, 0, sizeof(_map));
  memset(_sent, 0, sizeof(_sent));
  _clearValues();
}

void MockingbirdHIL::begin(const char* name) {
  _name = name ? name : "flight computer";
  _tag(F("$MBE,READY,"));
  _port.println(_name);
}

bool MockingbirdHIL::poll() {
  bool got = false;
  while (!got && _port.available() > 0) {
    int c = _port.read();
    if (c < 0) break;
    _lastRx = ::millis();
    if (c == '\n' || c == '\r') {
      if (_overflow) { _bad++; _overflow = false; _len = 0; continue; }
      if (_len) { _buf[_len] = 0; got = _handle(_buf); _len = 0; }
      continue;
    }
    if (_len < MB_LINE_MAX - 1) _buf[_len++] = (char)c;
    else _overflow = true;
  }
  if (_active) {
    uint32_t now = ::millis();
    if (now - _lastRx > 10000UL) {
      log(F("No data from Mockingbird for 10 s, leaving test mode"));
      _stop();
    } else if (now - _lastStats > 5000UL) {
      _stats();
    }
  }
  return got;
}

bool MockingbirdHIL::testStarted() { bool r = _started; _started = false; return r; }
bool MockingbirdHIL::testEnded() { bool r = _ended; _ended = false; return r; }

bool MockingbirdHIL::_handle(char* s) {
  if (s[0] != '$' || s[1] != 'M' || s[2] != 'B' || s[3] == 0 || s[4] != ',') return false;  // not for us
  char* star = strchr(s, '*');
  if (star) {
    uint8_t c = 0;
    for (char* p = s + 1; p < star; p++) c ^= (uint8_t)*p;
    int hi = mbHex(star[1]), lo = mbHex(star[2]);
    if (hi < 0 || lo < 0 || (uint8_t)((hi << 4) | lo) != c) { _bad++; return false; }
    *star = 0;
  }
  char kind = s[3];
  char* body = s + 5;
  if (kind == 'D') { _data(body); return _active; }
  if (kind == 'H') _header(body);
  else if (kind == 'C') _control(body);
  return false;
}

void MockingbirdHIL::_data(char* s) {
  if (!_ncols) return;                    // no header yet: wait for the next one
  if (!_active) _start(_rate, _scale);    // START was lost: begin anyway
  uint8_t col = 0;
  char* tok = s;
  while (tok && col < _ncols) {
    char* comma = strchr(tok, ',');
    if (comma) *comma = 0;
    uint8_t f = _map[col];
    if (f == LAT || f == LON) {
      bool ok;
      int32_t e7 = mbParseE7(tok, &ok);
      if (f == LAT) _latE7 = ok ? e7 : 0; else _lonE7 = ok ? e7 : 0;
    } else if (f == T_MS) {
      if (*tok) _tms = strtoul(tok, 0, 10);
    } else if (f) {
      _v[f] = *tok ? (float)atof(tok) : NAN;
    }
    col++;
    tok = comma ? comma + 1 : 0;
  }
  _rxAt = ::millis();
  _rxUs = ::micros();
  _good++;
}

void MockingbirdHIL::_header(char* s) {
  memset(_sent, 0, sizeof(_sent));
  _ncols = 0;
  char* tok = s;
  while (tok && _ncols < MB_MAX_COLS) {
    char* comma = strchr(tok, ',');
    if (comma) *comma = 0;
    uint8_t f = mbFieldId(tok);
    _map[_ncols++] = f;
    if (f) _sent[f] = true;
    tok = comma ? comma + 1 : 0;
  }
  for (uint8_t f = 1; f < FIELD_COUNT; f++) if (!_sent[f]) _v[f] = NAN;
}

void MockingbirdHIL::_control(char* s) {
  if (!strncmp(s, "START", 5)) {
    uint16_t rate = 50;
    float scale = 1.0f;
    char* p = strchr(s, ',');
    if (p) {
      rate = (uint16_t)atoi(p + 1);
      char* q = strchr(p + 1, ',');
      if (q) scale = (float)atof(q + 1);
    }
    _start(rate > 0 ? rate : 50, scale > 0 ? scale : 1.0f);
  } else if (!strncmp(s, "STOP", 4)) {
    if (_active) _stop();
  } else if (!strncmp(s, "PING", 4)) {
    _tag(F("$MBE,PONG,"));
    _port.println(_name);
  }
}

void MockingbirdHIL::_start(uint16_t rate, float scale) {
  _active = true;
  _started = true;
  _ended = false;
  _rate = rate;
  _scale = scale;
  _good = 0;
  _bad = 0;
  _tms = 0;
  _lastClock = 0;
  _clearValues();
  _rxAt = _lastRx = _lastStats = ::millis();
}

void MockingbirdHIL::_stop() {
  _stats();
  _active = false;
  _ended = true;
}

void MockingbirdHIL::_stats() {
  _lastStats = ::millis();
  _tag(F("$MBE,STATS,"));
  _port.print(_good);
  _port.print(',');
  _port.println(_bad);
}

void MockingbirdHIL::_clearValues() {
  for (uint8_t i = 0; i < FIELD_COUNT; i++) _v[i] = NAN;
  _latE7 = _lonE7 = 0;
}

void MockingbirdHIL::_tag(const __FlashStringHelper* tag) { _port.print(tag); }

uint32_t MockingbirdHIL::millis() {
  if (!_active) return ::millis();
  // Between samples, run on a little with the local clock so time doesn't
  // stand still; during a gap in the data, keep counting.
  uint32_t period = _rate ? 1000u / _rate : 20u;
  uint32_t ahead = (uint32_t)((::millis() - _rxAt) * _scale);
  if (ahead < 3 * period && ahead > period) ahead = period;
  uint32_t t = _tms + ahead;
  if (t < _lastClock) t = _lastClock;
  _lastClock = t;
  return t;
}

float MockingbirdHIL::accel(uint8_t axis) const {
  if (axis > 2) return NAN;
  float ms2 = _v[AX + axis];
  if (!isnan(ms2)) return ms2;
  float g = _v[AX_G + axis];
  return isnan(g) ? NAN : g * MB_G;
}

float MockingbirdHIL::accelG(uint8_t axis) const {
  if (axis > 2) return NAN;
  float g = _v[AX_G + axis];
  if (!isnan(g)) return g;
  float ms2 = _v[AX + axis];
  return isnan(ms2) ? NAN : ms2 / MB_G;
}

float MockingbirdHIL::gyro(uint8_t axis) const { return axis > 2 ? NAN : _v[GX + axis]; }

uint8_t MockingbirdHIL::satellites() const { return isnan(_v[SATS]) ? 0 : (uint8_t)_v[SATS]; }

// ---- reporting (only during a test, so flight serial output stays clean) ----
// Reports the channel, the sample time it acted on, and the microseconds from
// reading that sample to firing, so Mockingbird can time the decision.
void MockingbirdHIL::pyro(uint8_t channel) {
  if (!_active) return;
  uint32_t us = ::micros() - _rxUs;
  _tag(F("$MBE,PYRO,"));
  _port.print(channel);
  _port.print(',');
  _port.print(_tms);
  _port.print(',');
  _port.println(us);
}

void MockingbirdHIL::event(const char* name) {
  if (!_active) return;
  _tag(F("$MBE,"));
  _port.println(name);
}

void MockingbirdHIL::event(const __FlashStringHelper* name) {
  if (!_active) return;
  _tag(F("$MBE,"));
  _port.println(name);
}

void MockingbirdHIL::event(const char* name, const char* value) {
  if (!_active) return;
  _tag(F("$MBE,"));
  _port.print(name);
  _port.print(',');
  _port.println(value);
}

void MockingbirdHIL::state(const char* name) {
  if (!_active) return;
  _tag(F("$MBE,STATE,"));
  _port.println(name);
}

void MockingbirdHIL::state(const __FlashStringHelper* name) {
  if (!_active) return;
  _tag(F("$MBE,STATE,"));
  _port.println(name);
}

void MockingbirdHIL::telemetry(const char* name, float value) {
  if (!_active) return;
  _tag(F("$MBT,"));
  _port.print(name);
  _port.print(',');
  _port.println(value, 2);
}

void MockingbirdHIL::telemetry(const char* n1, float v1, const char* n2, float v2) {
  if (!_active) return;
  _tag(F("$MBT,"));
  _port.print(n1); _port.print(','); _port.print(v1, 2); _port.print(',');
  _port.print(n2); _port.print(','); _port.println(v2, 2);
}

void MockingbirdHIL::telemetry(const char* n1, float v1, const char* n2, float v2, const char* n3, float v3) {
  if (!_active) return;
  _tag(F("$MBT,"));
  _port.print(n1); _port.print(','); _port.print(v1, 2); _port.print(',');
  _port.print(n2); _port.print(','); _port.print(v2, 2); _port.print(',');
  _port.print(n3); _port.print(','); _port.println(v3, 2);
}

void MockingbirdHIL::log(const char* text) {
  if (!_active) return;
  _tag(F("$MBL,"));
  _port.println(text);
}

void MockingbirdHIL::log(const __FlashStringHelper* text) {
  if (!_active) return;
  _tag(F("$MBL,"));
  _port.println(text);
}
