@echo off
chcp 65001 >nul
title 荧光夜跑 - 后端 + 隧道
cd /d "%~dp0"

echo ============================================
echo   荧光夜跑系统 - 启动后端与公网隧道
echo ============================================
echo.

REM 1) 清理旧进程
echo [1/3] 清理旧进程...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8778 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }" 2>nul
powershell -NoProfile -Command "Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force" 2>nul
timeout /t 2 >nul

REM 2) 启动后端（跨域模式）
echo [2/3] 启动后端 (端口 8778)...
set PORT=8778
set COOKIE_CROSS_SITE=1
set ALLOWED_ORIGIN=*
set PUBLIC_ORIGIN=https://qzsf-nightrun.vercel.app
start "夜跑后端" /min cmd /c "node server/index.js > data\backend.log 2>&1"
timeout /t 4 >nul

REM 3) 启动隧道守护
echo [3/3] 启动 Cloudflare 隧道...
start "隧道守护" /min cmd /c "node data\cf-daemon.js --sync"
timeout /t 15 >nul

echo.
echo ============================================
echo   启动完成
echo ============================================
echo.
echo   公网地址: https://qzsf-nightrun.vercel.app
echo   本机地址: http://localhost:8778
echo.
if exist data\public-url.txt (
  echo   当前隧道: 
  type data\public-url.txt
  echo.
)
echo   选手页: https://qzsf-nightrun.vercel.app/?page=map
echo   后台页: https://qzsf-nightrun.vercel.app/?page=night-admin
echo.
echo   注意: 本窗口关闭后服务继续运行。
echo         隧道地址变化时守护进程会自动同步到 Vercel。
echo.
pause
