# Aviary source

Owl (ground station), Heron (flight data analyzer) and Mockingbird (flight computer tester) for Windows and Linux (64-bit PCs and Raspberry Pi 4/5). For using the apps, open **Read me.html** in the download.

## How it fits together

- `cmd/owl`, `cmd/heron`, `cmd/mockingbird`: one small Go program per app. Each serves its interface on `127.0.0.1` (ports 47710, 47720 and 47730, fixed so Edge remembers serial-port permissions) and opens it in an Edge app window. It also stores settings and files, relays UDP telemetry for Owl, and caches map tiles. The app quits when its window closes.
- `host/`: that shared Go code. `host_windows.go` finds the Documents folder (OneDrive-aware) and Edge or Chrome.
- `web/`: the interfaces (plain HTML, CSS and JavaScript modules, no build step), embedded into each `.exe`.
  - `web/shared/js/sim.js`: the 1-D flight simulator (stages, clusters, recovery, ISA atmosphere, wind drift, sensor models).
  - `web/shared/js/hil.js`: Mockingbird's engine: the wire protocol, fault injection, closed-loop pyro handling, grading, and the virtual flight computer.
  - `web/shared/js/analysis.js`, `flightlog.js`: Heron's log reader and flight analysis.
  - `web/shared/js/telemetry.js`, `fields.js`, `map.js`, `qr.js`: Owl's line parser, field recognition, tile map and QR codes.
  - `web/shared/js/serial.js`: Web Serial (Edge and Chrome).
- `arduino/MockingbirdHIL`: the Arduino library for flight computers.
- `tools/winres`: writes the Windows icon, version and manifest resources (standard library only).
- `web/shared/js/flight3d.js`, `flightviz.js`: the 2D and 3D flight animation (WebGL terrain from cached elevation tiles, no libraries).
- `web/shared/js/health.js`, `replay.js`: Heron's sensor health checks, and turning a log into a Mockingbird replay.

## Build

Needs Go 1.24 or newer. For the icons, `rsvg-convert` and ImageMagick.

```sh
./build-windows.sh          # build/windows/Owl.exe, Heron.exe, Mockingbird.exe
./build-linux.sh            # build/linux/Aviary-<version>-linux-amd64.tar.gz and -arm64.tar.gz
```

On Linux the apps open in Chromium, Chrome or Edge (needed for serial ports); unpack a tarball and run `./install.sh` to add them to the applications menu. Serial ports need the user in the `dialout` group.

On Windows without the icon tools: `go build -ldflags "-H windowsgui" -o Owl.exe ./cmd/owl` (and the same for heron and mockingbird).

For development, `go run ./cmd/owl` opens the app in your browser. The interface is embedded when the program builds, so after editing files in `web/`, close the window and run it again.

## Test

```sh
./build-native-tests.sh     # compiles the Arduino examples to run on this PC
node --test tests/*.test.js # simulator, analysis, protocol, grading, QR, and the library end to end
tests/restart.sh            # starts all three apps without windows for the browser tests
python3 tests/ui_mockingbird.py && python3 tests/ui_mockingbird_serial.py && python3 tests/ui_owl.py && python3 tests/ui_heron.py
```

The browser tests use Playwright for Python. `ui_mockingbird_serial.py` wires a stand-in serial port to the compiled `MockingbirdTry` example, so the interface, serial code, protocol and library run together.
