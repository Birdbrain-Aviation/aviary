# MockingbirdHIL

Arduino library for testing a rocket flight computer with **Mockingbird**. During a test, Mockingbird simulates a flight and streams barometer, accelerometer, gyro and GPS readings over serial. Your firmware reads them through this library instead of its real sensors. Your pyro decisions go back to Mockingbird, which deploys the parachute or lights the stage in the simulation and grades the result.

Works on AVR (Uno, Nano), RP2040/RP2350, STM32, ESP32, Teensy and other Arduino cores. No heap, about 330 bytes of RAM.

> **Safety:** take out igniters and e-matches and unplug the pyro battery before every test. Mockingbird makes the flight computer believe it is flying, so it will try to fire every charge.

## Install

Copy this `MockingbirdHIL` folder into `Documents\Arduino\libraries`, then restart the Arduino IDE. The examples are under **File › Examples › MockingbirdHIL**:

- **MockingbirdTry**: a complete small dual-deploy flight computer that only flies inside Mockingbird. Flash it to any board to see a test work end to end.
- **AddToYourFlightComputer**: the pattern for adding Mockingbird to your own firmware.

## Use

```cpp
#include <MockingbirdHIL.h>
MockingbirdHIL hil(Serial);

void setup() {
  Serial.begin(115200);          // same baud rate as in Mockingbird
  hil.begin("Fledgling");        // Mockingbird shows "Ready: Fledgling"
}

void loop() {
  bool sample = hil.poll();                  // call every loop
  if (hil.testStarted()) resetFlightState(); // once per test
  if (hil.active() && !sample) return;       // in a test, run once per sample

  float p = hil.active() ? hil.pressure() : readMyBarometer();   // Pa
  float a = hil.active() ? hil.accelG(2) : readMyAccelZ();       // g, 2 = Z
  uint32_t t = hil.millis();                 // simulated time in a test

  // ... your flight logic ...
  // if (deployDrogue) { if (hil.active()) hil.pyro(1); else firePyro(1); }
}
```

### Reading

| Call | Gives |
|---|---|
| `poll()` | Reads serial. `true` when a new sample arrived (one per call). |
| `active()` | `true` while a test runs. Use real sensors and real pyros when `false`. |
| `testStarted()`, `testEnded()` | `true` once at the start and end of each test. |
| `resumed()` | `true` once when a test carries on after the board restarted mid-flight (see [Restarts](#restarts)). |
| `millis()` | Simulated clock during a test, `::millis()` otherwise. Use it and tests can run faster than real time. |
| `sampleTime()` | Time of the latest sample, ms since the test started. |
| `pressure()`, `temperature()` | Pa, °C. |
| `accel(axis)`, `accelG(axis)` | m/s² or g; axis 0 = X, 1 = Y, 2 = Z. The nose axis reads +1 g on the pad. |
| `gyro(axis)` | °/s. |
| `latitudeE7()`, `longitudeE7()`, `latitude()`, `longitude()`, `gpsAltitude()`, `satellites()`, `hasGPS()` | GPS, when ticked in Mockingbird. |
| `trueAltitude()`, `trueVerticalSpeed()` | The simulator's truth, only if you tick `alt_m`/`vz` (debugging). |
| `has(field)` | Whether a field is in the stream, e.g. `has(MockingbirdHIL::LAT)`. |
| `samples()`, `damaged()` | Good samples and lines that failed their checksum this test. |

A value is `NAN` when it wasn't sent, or during a sensor dropout fault.

### Reporting

| Call | Sends | Mockingbird uses it for |
|---|---|---|
| `pyro(n)` | `$MBE,PYRO,n,ms,us` | Fires whatever channel *n* is wired to in the simulation. It also sends the time of the sample the board acted on and the microseconds from reading that sample to firing, for the pyro timing table. |
| `event(F("APOGEE"))` | `$MBE,APOGEE` | Detection timing. Also `LAUNCH`, `BURNOUT`, `LANDED`. |
| `state(F("COAST"))` | `$MBE,STATE,COAST` | Shown live and in the event list. |
| `telemetry("alt", a, "vel", v)` | `$MBT,alt,a,vel,v` | Drawn as dashed lines against the true flight, and scored: the result shows how far off the board's altitude and speed were, and a test fails when they're off by more than the limits on the Flight computer tab. Use names `alt` and `vel`, in **metres** and **m/s**. |
| `log(F("text"))` | `$MBL,text` | A note in the event list. |

Reports are only sent while a test is running, so a real flight's serial output stays clean. `DROGUE`, `MAIN`, `IGNITE` and `SEPARATE` events also work instead of pyro channel numbers.

## Restarts

The **Restart while coasting** test (and any test with a *Flight computer restarts* fault) checks what happens after a brownout or a watchdog reset in flight. Mockingbird sends `$MBC,REBOOT`, and the library answers `$MBE,RESTARTING` and restarts the board:

| Board | How |
|---|---|
| AVR (Uno, Nano, Mega) | the watchdog |
| ESP32, ESP8266 | `ESP.restart()` |
| RP2040, RP2350 (Earle Philhower core) | `rp2040.reboot()` |
| Any other ARM Cortex-M (STM32, SAMD, nRF52, Teensy, Mbed cores) | a system reset |

The simulated rocket keeps flying while the board boots. When it says `READY` again, Mockingbird sends `$MBC,RESUME` instead of `START`, so `testStarted()` stays false: from the firmware's point of view it has just woken up mid-flight, exactly as it would after a real brownout. Boards with USB built into the chip drop off USB while they restart; Mockingbird waits for the port to come back and reopens it.

A board passes when it carries on. Everything in RAM is gone, so the flight computer has to keep what it needs somewhere that survives a reset (EEPROM on AVR, `Preferences` on ESP32, flash on RP2040 and STM32):

```cpp
struct Saved { uint8_t magic, phase; float groundPressure; uint32_t launchMs; uint8_t fired; };

void save() { /* write Saved to EEPROM / flash when the phase changes or a channel fires */ }

void setup() {
  // ...
  Saved s = load();
  if (s.magic == 0xB1 && s.phase != PAD && s.phase != LANDED) {
    phase = s.phase; p0 = s.groundPressure; launchT = s.launchMs; fired = s.fired;
    seedFilterFromCurrentAltitude = true;   // don't start the filter at zero
  }
}
// Clear it in testStarted() and after landing.
```

The virtual flight computer in Mockingbird works this way; the MockingbirdTry example deliberately doesn't, so you can see the test catch it.

If your board needs something else to restart (an external watchdog, a power switch), define your own `void mbRestart() { ... }` in the sketch and the library uses it. On a Nano with the old bootloader, a watchdog reset can loop; flash the newer bootloader or define `mbRestart()`.

## Backup charges

To test a backup, give the device a second pyro channel on Mockingbird's Flight computer tab and have the firmware fire it too (a second later for the drogue, or lower for the main). The **Drogue charge doesn't go off** test makes the first charge fired for the apogee device do nothing, like an open e-match; it passes only if the backup deploys the parachute.

## Tips

- **Call `poll()` often.** An Uno or Nano holds only 64 received bytes, about 5 ms at 115200 baud. Long SD card writes can make it miss samples; Mockingbird's result shows how many arrived damaged. Lower the sample rate or untick fields you don't use if that happens.
- **Arduino boards restart when the port opens.** Leave "Restart the board (DTR)" on so every test starts from a fresh boot, and print nothing before `hil.begin()` that you need to see.
- **Close the Serial Monitor** before connecting Mockingbird: only one program can use a port.

## Protocol

Plain text lines at any baud rate. `*HH` is an NMEA-style XOR checksum of the characters between `$` and `*`.

```
PC → board   $MBC,START,<samples per second>,<time scale>*HH
             $MBH,<field>,<field>,...*HH        field names, resent every 2 s
             $MBD,<value>,<value>,...*HH        one sample, in header order
             $MBC,STOP*HH
             $MBC,PING*HH                       board answers $MBE,PONG,<name>
             $MBC,REBOOT*HH                     board answers $MBE,RESTARTING and restarts
             $MBC,RESUME,<rate>,<time scale>*HH carry on after a restart (no testStarted)
board → PC   $MBE,<EVENT>[,<value>]             READY, PYRO, APOGEE, STATE, STATS, RESTARTING, NORESTART...
             $MBT,<name>,<value>[,<name>,<value>...]
             $MBL,<text>
```

Fields: `t_ms`, `p_pa`, `temp_c`, `ax ay az` (m/s²), `ax_g ay_g az_g` (g), `gx gy gz` (°/s), `lat lon` (degrees), `gps_alt` (m), `sats`, plus `alt_m` and `vz` (truth, for debugging).

### Launch detection that ignores pad bumps

The MockingbirdTry example only treats a jump in acceleration as a *candidate* launch. It confirms launch once the push has lasted 0.15 s and the altitude has climbed 3 m, then dates the launch back to when the push began; if no climb follows within 1.5 s it was a bump (loading the rail, a knock, the igniter popping) and is forgotten. The "Knock on the pad" test checks for exactly this.

