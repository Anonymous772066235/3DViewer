@echo off
rem HoleOptimize bridge server (http://127.0.0.1:8790)
rem Keep this window open while using the "孔位优化" button in the viewer.
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "PY="

rem 1) Python Launcher
py -3 -c "import sys" >nul 2>nul && set "PY=py -3"

rem 2) python.exe from PATH, skipping the Microsoft Store stub
if not defined PY (
    for /f "delims=" %%I in ('where python 2^>nul') do (
        echo %%I | find /i "WindowsApps" >nul
        if errorlevel 1 if not defined PY set "PY=%%I"
    )
)

rem 3) common install locations
if not defined PY (
    for %%D in (
        "%LOCALAPPDATA%\Programs\Python\Python313"
        "%LOCALAPPDATA%\Programs\Python\Python312"
        "%LOCALAPPDATA%\Programs\Python\Python311"
        "%LOCALAPPDATA%\Programs\Python\Python310"
        "C:\Python313" "C:\Python312" "C:\Python311" "C:\Python310"
        "D:\ProgramData\miniforge3\envs\Env310"
        "D:\ProgramData\miniforge3"
        "D:\ProgramData\anaconda3"
        "D:\ProgramData\anaconda3\envs\Env310"
        "D:\ProgramData\anoconda"
        "D:\ProgramData\anoconda\envs\Env310"
        "%LOCALAPPDATA%\anaconda3"
        "%LOCALAPPDATA%\anaconda3\envs\Env310"
        "%USERPROFILE%\anaconda3"
        "%USERPROFILE%\anoconda"
        "C:\ProgramData\anaconda3"
    ) do if not defined PY if exist "%%~D\python.exe" set "PY=%%~D\python.exe"
)

rem 3b) auto-detect conda envs (envs\*) for miniforge / anaconda / anoconda
if not defined PY (
    for %%R in (
        "D:\ProgramData\miniforge3"
        "D:\ProgramData\anaconda3"
        "D:\ProgramData\anoconda"
        "%LOCALAPPDATA%\anaconda3"
        "%USERPROFILE%\anaconda3"
        "%USERPROFILE%\anoconda"
        "C:\ProgramData\anaconda3"
    ) do (
        if not defined PY if exist "%%~R\envs" (
            for /d %%E in ("%%~R\envs\*") do (
                if not defined PY if exist "%%~E\python.exe" set "PY=%%~E\python.exe"
            )
        )
    )
)

if not defined PY (
    echo [WARN] Python not found. Install Python 3 to use the optimize bridge.
    pause
    exit /b 1
)

%PY% bridge.py
pause
