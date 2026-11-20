// Calls a library function that doesn't exist, the way a model sometimes
// invents an API. The bench records the compiler's error and scores it as
// "did not compile".
#include <Adafruit_BMP3XX.h>
Adafruit_BMP3XX bmp;
void setup() { bmp.begin_I2C(); pinMode(5, OUTPUT); }
void loop() {
  float agl = bmp.readAltitudeAGL();
  if (agl > 100) digitalWrite(5, HIGH);
}
