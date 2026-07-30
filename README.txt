BALL FINDER — THE PHONE-ONLY VERSION
====================================

What this is
------------
The same ball-finding brain that runs on the PC, but living INSIDE your phone.
No PC, no DroidCam, no WiFi, no ntfy. You tap START, walk, and the phone
clicks like a metal detector when it sees a golf ball.

It is a web app that installs to your home screen like a normal app. After the
first install it works with no internet at all — the whole brain is saved on
the phone.

What is in this folder
----------------------
  index.html        the screen you see
  app.js            camera, the scanning loop, the clicks, the buzz
  ball_detect.js    the ball-finding rules (same numbers as local_infer.py)
  ball.onnx         THE BRAIN (a copy of local_model/weights_self_trained.onnx)
  ort/              the engine that runs the brain inside the phone browser
  sw.js             what makes it work offline
  manifest.webmanifest, icon-*.png    what makes it installable

Putting it on the phone
-----------------------
1. The folder gets uploaded to a free web host (once). You get a link like
   https://ball-finder.pages.dev
2. Open that link in Chrome on the phone, on WiFi. It downloads about 35 MB
   the first time (the brain plus the engine) — takes under a minute.
3. Chrome menu (three dots) -> "Add to Home screen" / "Install app".
4. Open it from the home screen from then on. It no longer needs the internet.

Using it in the field
---------------------
- Tap START. Say yes to the camera question the first time.
- "Head start" beeps once a second while you walk out, then three high beeps
  mean it is now scanning.
- Point the camera at the ground, a few yards ahead. Walk slowly.
- When it locks on: the phone buzzes, clicks speed up and rise in pitch the
  surer it is, and the clicks pan LEFT or RIGHT to say which side the ball is
  on. The big words say BALL LEFT / AHEAD / RIGHT with the percentage.
- The little square is a CLOSE-UP of what it thinks is a ball — glance at it
  to judge for yourself before you go digging.
- Earbud in = you hear the clicks properly. "Clicks" and "Buzz" can be turned
  off in the row under the button.
- Tap STOP for a summary: how many alerts, how long, how many pictures checked.

The same rules as the PC version
--------------------------------
40% bar, four frames in a row, and the ball has to stay in the SAME SPOT
(real balls hold still, noise jumps around). Checked against the PC's answers
on the same picture: they agree to five decimal places.

It checks about 8 pictures a second on purpose — walking pace does not need
more, and it keeps the phone cool and the battery alive.

Things to know
--------------
- Working range is still a few yards. Distant balls are too few pixels to see.
- The screen stays awake while a run is going, and sleeps again after STOP.
- Screen must stay ON: Android shuts the camera off for background pages.
  Screen on, phone clipped facing the ground, earbud in.
- It never uploads anything. No account, no internet, nothing leaves the phone.

After you retrain the brain on the PC
-------------------------------------
Run this in the ball2 folder:

    py -3.13 update_phone_brain.py

That copies the new brain in here and bumps the version number in sw.js, then
tells you the one command to publish it. The phone picks up the new brain the
next time it is opened with internet.
