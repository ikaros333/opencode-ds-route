@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [x] 没找到 Node。请先安装 Node 22 LTS: https://nodejs.org/
  pause
  exit /b 1
)

echo 启动门控（前台运行 + 进程监护，关闭窗口即停止）...
node bin\ocg-supervise.mjs
echo.
echo 门控已退出，按任意键关闭窗口。
pause >nul
