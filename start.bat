@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ==========================================================
echo   泉州师范学院 · 校园定向越野
echo ==========================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [错误] 未安装 Node.js，请先安装 Node 22.5 或更高版本
  echo        https://nodejs.org/
  pause
  exit /b 1
)

if not exist ".env" (
  echo [提示] 未找到 .env，正在从 .env.example 创建...
  copy /y ".env.example" ".env" >nul
  echo [提示] 请编辑 .env 修改 ADMIN_PASSWORD 后再启动
  echo.
)

if not exist "data\qzsf.db" (
  echo [初始化] 创建赛事数据...
  node server\scripts\seed.js
  echo.
)

echo 正在启动服务...
echo.
start "" http://localhost:8777
node server\index.js
