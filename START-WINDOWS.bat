@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  echo Starting City Eyes 3.0 on http://localhost:8000
  start "City Eyes" "http://localhost:8000"
  py -m http.server 8000
  goto end
)
where python >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  echo Starting City Eyes 3.0 on http://localhost:8000
  start "City Eyes" "http://localhost:8000"
  python -m http.server 8000
  goto end
)
echo Python is not installed or not in PATH.
echo Open this folder in VS Code and start the Live Server extension instead.
pause
:end
endlocal
