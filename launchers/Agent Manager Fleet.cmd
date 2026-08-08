@echo off
where agent-manager-fleet >nul 2>nul
if errorlevel 1 (
  echo agent-manager-fleet is not on PATH. Install Agent Manager with npm link or npm install -g.
  pause
  exit /b 1
)

call agent-manager-fleet %*
