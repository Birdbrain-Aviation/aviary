#!/bin/bash
# Builds Owl, Heron and Mockingbird for Linux on 64-bit PCs (amd64) and
# 64-bit ARM boards such as the Raspberry Pi 4 and 5 (arm64), each packed with
# icons, menu entries and an installer. Run from the project folder.
set -euo pipefail
cd "$(dirname "$0")"
VER=${VER:-1.2.1}
declare -A NAME=([owl]=Owl [heron]=Heron [mockingbird]=Mockingbird)
declare -A DESC=([owl]="Ground station for any rocket's telemetry" [heron]="Flight data analyzer for any rocket's logs" [mockingbird]="Flight computer tester (firmware in the loop)")
mkdir -p build/linux
for arch in amd64 arm64; do
  pkg="build/linux/Aviary-$VER-linux-$arch"
  rm -rf "$pkg"; mkdir -p "$pkg/bin" "$pkg/icons" "$pkg/applications"
  for app in owl heron mockingbird; do
    GOOS=linux GOARCH=$arch CGO_ENABLED=0 go build -trimpath -ldflags "-X aviary/host.Version=$VER" -o "$pkg/bin/aviary-$app" "./cmd/$app"
    rsvg-convert -w 256 -h 256 "web/$app/icon.svg" -o "$pkg/icons/aviary-$app.png"
    cat > "$pkg/applications/aviary-$app.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=${NAME[$app]}
Comment=${DESC[$app]}
Exec=aviary-$app
Icon=aviary-$app
Terminal=false
Categories=Science;Engineering;
DESK
  done
  cp "docs/Read me.html" "$pkg/"
  cp -r arduino "$pkg/Arduino"
  cat > "$pkg/install.sh" <<'INST'
#!/bin/bash
# Installs Aviary for this user: programs in ~/.local/bin, menu entries and icons.
set -e
cd "$(dirname "$0")"
mkdir -p ~/.local/bin ~/.local/share/applications ~/.local/share/icons/hicolor/256x256/apps
install -m 755 bin/aviary-* ~/.local/bin/
install -m 644 icons/*.png ~/.local/share/icons/hicolor/256x256/apps/
for f in applications/*.desktop; do sed "s#^Exec=#Exec=$HOME/.local/bin/#" "$f" > ~/.local/share/applications/$(basename "$f"); done
update-desktop-database ~/.local/share/applications 2>/dev/null || true
echo "Installed Owl, Heron and Mockingbird. Find them in your applications menu, or run aviary-owl, aviary-heron or aviary-mockingbird."
if ! command -v chromium >/dev/null && ! command -v chromium-browser >/dev/null && ! command -v google-chrome >/dev/null && ! command -v microsoft-edge >/dev/null; then
  echo "Note: install Chromium, Chrome or Edge. The apps open in it, and serial ports need it (Firefox can't open serial ports)."
fi
if ! id -nG | grep -qw dialout; then
  echo "For USB serial (radios, flight computers): sudo usermod -aG dialout $(id -un), then log out and back in."
fi
INST
  chmod +x "$pkg/install.sh"
  cat > "$pkg/README.txt" <<TXT
Aviary $VER for Linux ($arch)

  ./install.sh      adds Owl, Heron and Mockingbird to your applications menu

Or run them straight from bin/. Each opens in Chromium, Chrome or Edge as an
app window and quits when you close it. Files go to ~/Documents/Aviary, map
and elevation tiles to ~/.cache/Aviary. See "Read me.html" for how to use them.

Serial ports (USB radios, flight computers) need Chromium, Chrome or Edge, and
your user in the dialout group: sudo usermod -aG dialout \$USER
TXT
  tar -C build/linux -czf "build/linux/Aviary-$VER-linux-$arch.tar.gz" "Aviary-$VER-linux-$arch"
  echo "built build/linux/Aviary-$VER-linux-$arch.tar.gz"
done
