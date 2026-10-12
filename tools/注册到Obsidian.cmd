@echo off
chcp 65001 >nul
title Register knowledge base into Obsidian vault list
echo ============================================================
echo  Registering  %~dp0..  into Obsidian
echo ============================================================
echo.
node "%~dp0link-obsidian-vault.mjs"
echo.
echo ------------------------------------------------------------
echo  If it says "already registered", nothing more to do.
echo  Make sure Obsidian is FULLY QUIT before running this.
echo ------------------------------------------------------------
pause
