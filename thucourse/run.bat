@echo off
setlocal
title THUxk Local Server

rem Serve from main because pages use absolute /thucourse/ and /data/ URLs.
for %%d in ("%~dp0..") do set "WEB_ROOT=%%~fd"
set "PORT=8080"
if not "%~1"=="" set "PORT=%~1"
set "SITE_URL=http://127.0.0.1:%PORT%/thucourse/"

cd /d "%WEB_ROOT%"
if errorlevel 1 (
    echo [ERROR] Cannot open the web root:
    echo         %WEB_ROOT%
    goto :failed
)

rem Do not rely on WHERE: Windows execution aliases may not be reported by it.
set "PYTHON_CMD="
python -c "import sys" >nul 2>nul
if not errorlevel 1 set "PYTHON_CMD=python"
if defined PYTHON_CMD goto :python_found

python3 -c "import sys" >nul 2>nul
if not errorlevel 1 set "PYTHON_CMD=python3"
if defined PYTHON_CMD goto :python_found

py -3 -c "import sys" >nul 2>nul
if not errorlevel 1 set "PYTHON_CMD=py -3"
if defined PYTHON_CMD goto :python_found

echo [ERROR] Python 3 was not found.
echo         Install it from https://www.python.org/downloads/
goto :failed

:python_found
rem Validate the port before opening a browser window.
%PYTHON_CMD% -c "import socket,sys; s=socket.socket(); s.bind(('127.0.0.1',int(sys.argv[1]))); s.close()" "%PORT%" >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Port %PORT% is invalid or already in use.
    echo         Stop the old server with Ctrl+C, or run:
    echo         run.bat 8081
    goto :failed
)

echo.
echo ========================================
echo   THUxk local server
echo ========================================
echo Python:   %PYTHON_CMD%
echo Web root: %WEB_ROOT%
echo Website:  %SITE_URL%
echo Stop:     Ctrl+C
echo.

rem THUXK_NO_BROWSER=1 is useful for automated checks.
if /i not "%THUXK_NO_BROWSER%"=="1" (
    start "" cmd /d /c "timeout /t 2 /nobreak >nul && start %SITE_URL%"
)

%PYTHON_CMD% -m http.server %PORT% --bind 127.0.0.1
set "SERVER_EXIT=%ERRORLEVEL%"
if not "%SERVER_EXIT%"=="0" echo [ERROR] The local server exited with code %SERVER_EXIT%.
if /i not "%THUXK_NO_PAUSE%"=="1" pause
exit /b %SERVER_EXIT%

:failed
if /i not "%THUXK_NO_PAUSE%"=="1" pause
exit /b 1
