@echo off
setlocal
cd /d "%~dp0"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.13 or newer is required.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Install the project dependencies first with: npm install
  pause
  exit /b 1
)

call npm.cmd run build:static
if errorlevel 1 (
  echo The local site build failed.
  pause
  exit /b 1
)

call npm.cmd run preview:static:open
