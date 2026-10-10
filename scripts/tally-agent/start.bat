@echo off
title SEPL Tally Sync Agent
cd /d "%~dp0"
echo ===================================================
echo Starting SEPL Tally Sync Agent...
echo Press Ctrl+C at any time to stop the agent.
echo ===================================================
node agent.js
pause
