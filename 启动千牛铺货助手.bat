@echo off
chcp 65001 >nul
title 千牛铺货助手
cd /d "%~dp0"
echo 正在启动千牛铺货助手...
npx electron .
if errorlevel 1 (
  echo.
  echo 启动失败：请确认已安装 Node.js（https://nodejs.org），并在本目录执行过 npm install
  pause
)
