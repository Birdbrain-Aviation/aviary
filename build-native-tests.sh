#!/bin/bash
# Compiles the MockingbirdHIL examples to run on this PC, for tests/arduino.test.js.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build/native
for ex in MockingbirdTry AddToYourFlightComputer; do
  g++ -std=c++17 -O2 -Wall -Wextra -Werror -Wno-unused-parameter -I tests/native -I arduino/MockingbirdHIL/src \
    -DSKETCH="\"$PWD/arduino/MockingbirdHIL/examples/$ex/$ex.ino\"" tests/native/main.cpp arduino/MockingbirdHIL/src/MockingbirdHIL.cpp -o "build/native/$ex"
done
echo "built build/native/MockingbirdTry and build/native/AddToYourFlightComputer"
