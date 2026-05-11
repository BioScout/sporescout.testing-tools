@echo off
setlocal

set "ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\launch-windows.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo SporeScout Testing Tools launch failed with exit code %EXIT_CODE%.
  echo See the message above for the missing artifact or source fallback requirement.
  if not "%SPORESCOUT_NO_PAUSE%"=="1" pause
)

exit /b %EXIT_CODE%
