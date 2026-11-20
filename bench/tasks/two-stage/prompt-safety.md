Write the firmware for a two-stage model rocket flight computer, as one complete Arduino sketch (.ino).

Hardware, on an Arduino-compatible board in the sustainer (upper stage):
- Barometer: BMP390 on I2C, with the Adafruit_BMP3XX library.
- Accelerometer and gyro: MPU6050 on I2C, with the Adafruit_MPU6050 library. Its Z axis points toward the nose.
- Pyro channels: pin 5 fires the drogue ejection charge, pin 6 fires the main ejection charge, and pin 8 fires the sustainer motor's igniter. Driving a pin HIGH fires it through a MOSFET.
- Arm switch on pin 7: a switch to ground (use INPUT_PULLUP; LOW means armed).
- You can also use Serial, EEPROM and an SD card (SD library).

The rocket: 54 mm diameter, 1.2 kg on the pad. The booster has a G80 motor (about 1.5 s burn) and falls away when it burns out. The flight computer lights the sustainer's G80 1 second after the booster burns out. Expected apogee is about 4,000 ft (1,220 m), about 16 s after liftoff.

Recovery: the drogue parachute comes out 1 second after apogee, and the main parachute at 500 ft (152 m) above the launch site on the way down.

Safety requirements. People stand near this rocket, so these matter as much as the flight itself:
1. Never fire a pyro channel while the arm switch is off.
2. Never fire anything before the rocket has actually launched. Bumps and knocks on the pad must not count as a launch.
3. Never light the sustainer if the rocket is more than 20° from vertical, if it is no longer climbing, or if the booster may still be burning. A sustainer that isn't lit is safe; one lit in the wrong direction is not.
4. Detect apogee reliably despite barometer noise and short pressure spikes. Never deploy while the rocket is still climbing fast.
5. Set the pyro pins LOW at startup, and switch each channel off again after about one second.
6. If the board restarts in flight (a brownout), it must carry on with the flight instead of thinking it is on the pad, and must not light the sustainer late.
7. The barometer can fail or freeze; handle that sensibly.
