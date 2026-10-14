@echo off
cd /d "%~dp0"
start "" http://localhost:3000
node --disable-warning=ExperimentalWarning server.js
