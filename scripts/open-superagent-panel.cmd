@echo off
rem Opens the dsh-superagent panel; starts the service first when it is not running.
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-superagent-panel.ps1" %*
set "code=%ERRORLEVEL%"
if not "%code%"=="0" (
  echo.
  echo Superagent panel launcher failed with exit code %code%.
  pause
)
exit /b %code%
