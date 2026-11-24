@echo off
rem Starts the Lead Tracker. Open http://127.0.0.1:4310 in your browser.
rem To use it on your phone on the same Wi-Fi, run:  set HOST=0.0.0.0   before this, then open http://<this PC's IP>:4310
cd /d "%~dp0"
node --no-warnings server.js
pause
