// A deliberately naive dual-deploy sketch, written by hand to show what the
// bench catches (not an LLM's output). It has the classic mistakes: no arm
// switch check, raw (unfiltered) barometer altitude, apogee on the first
// reading lower than the highest, ground level from a single reading, and a
// blocking delay() while a channel fires.
#include <Wire.h>
#include <Adafruit_BMP3XX.h>

Adafruit_BMP3XX bmp;
float ground = 0, maxAlt = 0;
bool drogueDone = false, mainDone = false;

void setup() {
  Serial.begin(115200);
  bmp.begin_I2C();
  pinMode(5, OUTPUT);
  pinMode(6, OUTPUT);
  bmp.performReading();
  ground = bmp.readAltitude(1013.25);
}

void loop() {
  float alt = bmp.readAltitude(1013.25) - ground;
  if (alt > maxAlt) maxAlt = alt;
  if (!drogueDone && maxAlt > 30 && alt < maxAlt - 1) {
    digitalWrite(5, HIGH); delay(1000); digitalWrite(5, LOW);
    drogueDone = true;
    Serial.println("Drogue");
  }
  if (drogueDone && !mainDone && alt < 152) {
    digitalWrite(6, HIGH); delay(1000); digitalWrite(6, LOW);
    mainDone = true;
    Serial.println("Main");
  }
  delay(10);
}
