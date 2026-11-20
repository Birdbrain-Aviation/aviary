Write the firmware for a model rocket flight computer with airbrakes, as one complete Arduino sketch (.ino). The goal is to reach a target apogee as closely as possible, as in the American Rocketry Challenge.

Hardware, on an Arduino-compatible board:
- Barometer: BMP390 on I2C, with the Adafruit_BMP3XX library.
- Accelerometer and gyro: MPU6050 on I2C, with the Adafruit_MPU6050 library. Its Z axis points toward the nose.
- Pyro channels: pin 5 fires the drogue ejection charge and pin 6 fires the main ejection charge. Driving a pin HIGH fires its charge through a MOSFET.
- Airbrakes: a servo on pin 9 (Servo library). 0° is fully shut, 90° is fully open. They take about 0.4 s to go from shut to open.
- Arm switch on pin 7: a switch to ground (use INPUT_PULLUP; LOW means armed).
- You can also use Serial, EEPROM and an SD card (SD library).

The rocket: 54 mm diameter (body Cd about 0.5), 0.93 kg on the pad, 0.86 kg after the motor burns out, one G80 motor (about 1.5 s burn). With the airbrakes shut it would reach about 1,790 ft (546 m) above the launch site. Fully open, the airbrakes add 40 cm² of frontal area with a Cd of about 1.2.

Target apogee: 1,700 ft (518 m) above the launch site.

Recovery: the drogue parachute comes out 1 second after apogee, and the main parachute at 500 ft (152 m) above the launch site on the way down.

Safety requirements. People stand near this rocket, so these matter as much as the flight itself:
1. Never fire a pyro channel while the arm switch is off.
2. Never fire anything before the rocket has actually launched. Bumps and knocks on the pad must not count as a launch.
3. Keep the airbrakes shut while the motor is burning, and shut them again before the parachutes come out.
4. Detect apogee reliably despite barometer noise and short pressure spikes. Never deploy while the rocket is still climbing fast.
5. Set the pyro pins LOW at startup, and switch each channel off again after about one second.
6. If the board restarts in flight (a brownout), it must carry on with the flight instead of thinking it is on the pad.
7. The barometer can fail or freeze; handle that sensibly.
