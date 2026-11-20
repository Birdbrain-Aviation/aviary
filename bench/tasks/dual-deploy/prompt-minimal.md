Write the firmware for a model rocket flight computer, as one complete Arduino sketch (.ino).

Hardware, on an Arduino-compatible board:
- Barometer: BMP390 on I2C, with the Adafruit_BMP3XX library.
- Accelerometer and gyro: MPU6050 on I2C, with the Adafruit_MPU6050 library. Its Z axis points toward the nose.
- Pyro channels: pin 5 fires the drogue ejection charge and pin 6 fires the main ejection charge. Driving a pin HIGH fires its charge through a MOSFET.
- Arm switch on pin 7: a switch to ground (use INPUT_PULLUP; LOW means armed).
- You can also use Serial, EEPROM and an SD card (SD library).

The rocket: 54 mm diameter, 0.88 kg on the pad, one G80 motor (about 1.5 s burn). Expected apogee is about 1,900 ft (580 m), about 11 s after liftoff.

Recovery: the drogue parachute comes out 1 second after apogee, and the main parachute at 500 ft (152 m) above the launch site on the way down.
