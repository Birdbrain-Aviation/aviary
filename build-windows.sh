#!/bin/bash
# Builds Owl.exe, Heron.exe and Mockingbird.exe for 64-bit Windows, with icons,
# version information and no console window. Run from the project folder.
set -euo pipefail
cd "$(dirname "$0")"
VER=${VER:-1.1.0}
mkdir -p build/icons build/windows
declare -A NAME=([owl]=Owl [heron]=Heron [mockingbird]=Mockingbird)
declare -A DESC=([owl]="Owl ground station" [heron]="Heron flight data analyzer" [mockingbird]="Mockingbird flight computer tester")
for app in owl heron mockingbird; do
  sizes=(16 20 24 32 40 48 64 128 256)
  pngs=()
  for s in "${sizes[@]}"; do
    rsvg-convert -w "$s" -h "$s" "web/$app/icon.svg" -o "build/icons/$app-$s.png"
    pngs+=("build/icons/$app-$s.png")
  done
  convert "${pngs[@]}" "build/icons/$app.ico"
  go run ./tools/winres -ico "build/icons/$app.ico" -name "${NAME[$app]}" -desc "${DESC[$app]}" -version "$VER" -exe "${NAME[$app]}.exe" -out "cmd/$app/rsrc_windows_amd64.syso"
  GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H windowsgui -X aviary/host.Version=$VER" -o "build/windows/${NAME[$app]}.exe" "./cmd/$app"
  go run ./tools/winres -check "build/windows/${NAME[$app]}.exe"
done
ls -la build/windows
