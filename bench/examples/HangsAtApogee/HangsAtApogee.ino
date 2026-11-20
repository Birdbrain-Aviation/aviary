// Fires the drogue at apogee, then spins in a loop that never reads a sensor
// or the clock, so the main never fires. The bench notices the board stopped
// asking for readings and records a hang.
#include <Adafruit_BMP3XX.h>
Adafruit_BMP3XX bmp;
float ground = 0, maxAlt = 0;
volatile long spins = 0;

void setup() {
  digitalWrite(5, LOW); digitalWrite(6, LOW);
  pinMode(5, OUTPUT); pinMode(6, OUTPUT);
  pinMode(7, INPUT_PULLUP);
  bmp.begin_I2C();
  for (int i = 0; i < 50; i++) { bmp.performReading(); ground += bmp.readAltitude(1013.25) / 50; delay(20); }
}

void loop() {
  bmp.performReading();
  float alt = bmp.readAltitude(1013.25) - ground;
  if (alt > maxAlt) maxAlt = alt;
  if (maxAlt > 100 && alt < maxAlt - 15 && digitalRead(7) == LOW) {
    digitalWrite(5, HIGH);
    delay(1000);
    digitalWrite(5, LOW);
    while (true) spins++;   // "done": waits forever
  }
  delay(10);
}
