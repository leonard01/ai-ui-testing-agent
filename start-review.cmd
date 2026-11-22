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

echo Starting testing UI at http://127.0.0.1:3100/
call npm run review
if errorlevel 1 (
  echo Testing UI stopped with an error.
  pause
  exit /b 1
)
endlocal
