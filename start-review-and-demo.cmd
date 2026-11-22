@echo off
setlocal
cd /d "%~dp0"

echo Building AI UI Testing Agent...
call npm run build
if errorlevel 1 (
  echo Build failed. Review the output above.
  pause
  exit /b 1
)

echo Starting demo application at http://127.0.0.1:3000/
start "AI UI Test Demo" /D "%~dp0" cmd /k "npm run demo"

echo Starting testing UI at http://127.0.0.1:3100/
call npm run review
if errorlevel 1 (
  echo Testing UI stopped with an error.
  pause
  exit /b 1
)
endlocal
