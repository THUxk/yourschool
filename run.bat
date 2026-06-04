@echo off
chcp 65001 >nul
title THU选课社区

cd /d "%~dp0"

echo.
echo ╔════════════════════════════════╗
echo ║     THU 选课社区 - 本地启动    ║
echo ╚════════════════════════════════╝
echo.

:: 尝试找 Python
set PYTHON=
for %%p in (python python3 py) do (
    where %%p >nul 2>nul
    if not errorlevel 1 (
        set PYTHON=%%p
        goto :found
    )
)

echo [错误] 未找到 Python，请先安装 Python 或将其添加到 PATH。
echo        下载地址: https://www.python.org/downloads/
pause
exit /b 1

:found
echo [信息] 使用 %PYTHON% 启动本地服务器...
echo.
echo   网站地址: http://localhost:8080
echo   按 Ctrl+C 可停止服务器
echo.

:: 延迟 1 秒后打开浏览器（等服务器启动）
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:8080"

:: 启动 HTTP 服务器
%PYTHON% -m http.server 8080 --bind 127.0.0.1

pause
