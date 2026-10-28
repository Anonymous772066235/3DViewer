@echo off
rem Local launcher: static viewer + optimize bridge run in ONE process (same origin).
rem Usage: double-click this file, the browser opens http://127.0.0.1:8765/ automatically.
setlocal
chcp 65001 >nul
set "DIR=%~dp0"
set "PORT=8765"
set "PY="

rem 1) Python Launcher (most portable)
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
    echo [WARN] Python not found.
    echo        You can still double-click index.html to browse files,
    echo        but clipboard / "?url=" / the optimize button need this local server.
    pause
    exit /b 1
)

set "VIEWER_PORT=%PORT%"
echo Viewer + optimize bridge -> http://127.0.0.1:%PORT%/index.html
%PY% "%DIR%server\serve.py"
pause
