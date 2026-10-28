<#
  Smoke test: run key scenarios once, assert no JS error and key UI markers, keep screenshots.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File check.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File check.ps1 -Chrome "C:\path\to\chrome.exe"

  Notes:
    - Auto-detects Chrome/Edge; use -Chrome to override.
    - Starts server\serve.py on port 8765 if not running (stops it afterwards only if started here).
    - Test model is copied from ..\HoleOptimize\data to _t\m.stl.
    - Artifacts go to _t\smoke\ (ignored by .gitignore).
    - ASCII only on purpose: Windows PowerShell reads .ps1 as ANSI by default.
#>
param(
    [string]$Chrome = '',
    [string]$BaseUrl = 'http://127.0.0.1:8765'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$tDir = Join-Path $root '_t'
$outDir = Join-Path $tDir 'smoke'
$model = Join-Path $tDir 'm.stl'
$prof = Join-Path $tDir 'smoke_prof'
$py = ''

New-Item -ItemType Directory -Path $outDir -Force | Out-Null

# ---------- 1. locate browser ----------
if (-not $Chrome) {
    $cands = @(
        'C:\Program Files\Google\Chrome\Application\chrome.exe',
        'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
        'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
        'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
    )
    foreach ($c in $cands) { if (Test-Path $c) { $Chrome = $c; break } }
}
if (-not $Chrome -or -not (Test-Path $Chrome)) {
    Write-Host 'Browser not found. Pass -Chrome <path>.' -ForegroundColor Red
    exit 2
}
Write-Host ("Browser: " + $Chrome)

# ---------- 2. prepare model ----------
$src = Join-Path $root '..\HoleOptimize\data\kongwei\1.0-kongwei.stl'
$src2 = Join-Path $root '..\HoleOptimize\data'
if (-not (Test-Path $model)) {
    $found = Get-ChildItem -Path $src2 -Recurse -Filter '1.0-*.stl' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { Copy-Item -LiteralPath $found.FullName -Destination $model -Force }
    else { Write-Host 'Test model not found under ..\HoleOptimize\data' -ForegroundColor Red; exit 2 }
}

# ---------- 3. ensure server ----------
function Test-Health {
    try {
        $r = Invoke-WebRequest -Uri ($BaseUrl + '/health') -UseBasicParsing -TimeoutSec 3
        return $r.StatusCode -eq 200
    } catch { return $false }
}

$started = $false
if (-not (Test-Health)) {
    $pyCands = @(
        'D:\ProgramData\miniforge3\envs\Env310\python.exe',
        'py',
        'python'
    )
    foreach ($c in $pyCands) {
        try {
            $null = & $c -c "import sys"
            $py = $c
            break
        } catch { }
    }
    if (-not $py) { Write-Host 'Python not found' -ForegroundColor Red; exit 2 }

    $env:VIEWER_NOBROWSER = '1'
    Start-Process -FilePath $py -ArgumentList 'server\serve.py' -WorkingDirectory $root -WindowStyle Hidden
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 400
        if (Test-Health) { break }
    }
    if (-not (Test-Health)) { Write-Host 'Server failed to start (port 8765)' -ForegroundColor Red; exit 2 }
    $started = $true
    Write-Host 'Server started by this script'
}

# ---------- 4. cases ----------
$cases = @(
    @{ name = 'base';     q = 'url=_t/m.stl&slot=B&debug=1';                    must = @('err=0') },
    @{ name = 'single';   q = 'url=_t/m.stl&slot=B&single=1&debug=1';           must = @('err=0') },
    @{ name = 'pick';     q = 'url=_t/m.stl&slot=B&single=1&debug=1&demo=pick'; must = @('err=0', 'pick-list') },
    @{ name = 'segment';  q = 'url=_t/m.stl&slot=B&single=1&debug=1&demo=seg&segapply=1'; must = @('err=0', '_segmented') },
    @{ name = 'boundary'; q = 'url=_t/m.stl&slot=B&single=1&debug=1&boundary=1'; must = @('err=0', 'p-boundary') },
    @{ name = 'mempopup'; q = 'url=_t/m.stl&slot=B&debug=1&memlimit=2';        must = @('memdlg') }
)

$results = @()

foreach ($c in $cases) {
    $url = $BaseUrl + '/index.html?' + $c.q
    $dom = Join-Path $outDir ($c.name + '.html')
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $prof

    $cargs = @(
        '--headless=new', "--user-data-dir=$prof", '--disable-gpu', '--enable-unsafe-swiftshader',
        '--no-first-run', '--window-size=1400,900', '--virtual-time-budget=30000000',
        '--dump-dom', $url
    )
    Start-Process -FilePath $Chrome -ArgumentList $cargs -RedirectStandardOutput $dom `
        -RedirectStandardError (Join-Path $outDir ($c.name + '.log')) -Wait -NoNewWindow | Out-Null

    $html = ''
    if (Test-Path $dom) { $html = [System.IO.File]::ReadAllText($dom, [System.Text.Encoding]::UTF8) }

    $missing = @()
    foreach ($m in $c.must) {
        if ($html -notmatch [regex]::Escape($m)) { $missing += $m }
    }
    # memdlg must be visible (class without 'hidden')
    if ($c.name -eq 'mempopup') {
        if ($html -notmatch 'id="memdlg"') { $missing += 'memdlg' }
        elseif ($html -match 'id="memdlg"[^>]*class="[^"]*hidden') { $missing += 'memdlg-hidden' }
    }

    if ($missing.Count -eq 0) { $status = 'PASS' } else { $status = 'FAIL(' + ($missing -join ',') + ')' }
    $results += New-Object psobject -Property @{ Case = $c.name; Result = $status }
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $prof
}

# ---------- 5. screenshots ----------
foreach ($c in $cases) {
    $url = $BaseUrl + '/index.html?' + $c.q
    $png = Join-Path $outDir ($c.name + '.png')
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $prof
    $sargs = @(
        '--headless=new', "--user-data-dir=$prof", '--disable-gpu', '--enable-unsafe-swiftshader',
        '--no-first-run', '--window-size=1400,900', '--virtual-time-budget=30000000',
        "--screenshot=$png", $url
    )
    Start-Process -FilePath $Chrome -ArgumentList $sargs -Wait -NoNewWindow | Out-Null
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $prof
}


# ---------- 5b. cull parity: 剔除不得改变画面 ----------
function Get-Sample([string]$path, [int]$step)
{
    Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
    $bmp = [System.Drawing.Bitmap]::new($path)
    $vals = New-Object System.Collections.Generic.List[int]
    for ($y = 0; $y -lt $bmp.Height; $y += $step)
    {
        for ($x = 0; $x -lt $bmp.Width; $x += $step)
        {
            $c = $bmp.GetPixel($x, $y)
            $vals.Add($c.R); $vals.Add($c.G); $vals.Add($c.B)
        }
    }
    $bmp.Dispose()
    return ,$vals.ToArray()
}

$pngOn = Join-Path $outDir 'cull_on.png'
$pngOff = Join-Path $outDir 'cull_off.png'
$pair = @(
    @{ q = 'url=_t/m.stl&slot=B&single=1'; o = $pngOn },
    @{ q = 'url=_t/m.stl&slot=B&single=1&cull=0'; o = $pngOff }
)
foreach ($p in $pair)
{
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $prof
    $shotPng = $p.o
    $pageUrl = $BaseUrl + '/index.html?' + $p.q
    $pargs = @(
        '--headless=new', "--user-data-dir=$prof", '--disable-gpu', '--enable-unsafe-swiftshader',
        '--no-first-run', '--window-size=1400,900', '--virtual-time-budget=30000000',
        "--screenshot=$shotPng", $pageUrl
    )
    Write-Host ("  parity shot: " + $shotPng)
    Start-Process -FilePath $Chrome -ArgumentList $pargs -Wait -NoNewWindow | Out-Null
    if (Test-Path $shotPng) { Write-Host ("  parity shot ok: " + (Get-Item $shotPng).Length + " B") }
    else { Write-Host "  parity shot FAILED" }
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $prof
}

$parityStatus = 'SKIP'
if ((Test-Path $pngOn) -and (Test-Path $pngOff))
{
    $sa = Get-Sample $pngOn 5
    $sb = Get-Sample $pngOff 5
    $n = [math]::Min($sa.Count, $sb.Count)
    $diff = 0
    for ($i = 0; $i -lt $n; $i++)
    {
        if ([math]::Abs($sa[$i] - $sb[$i]) -gt 8) { $diff++ }
    }
    $ratio = if ($n -gt 0) { $diff / $n } else { 1 }
    if ($ratio -lt 0.01) { $parityStatus = 'PASS' }
    else { $parityStatus = 'FAIL(diff=' + [math]::Round($ratio * 100, 2) + '%)' }
}
$results += New-Object psobject -Property @{ Case = 'cull-parity'; Result = $parityStatus }

# ---------- 6. report ----------
Write-Host ''
$results | Format-Table -AutoSize | Out-String -Width 80 | Write-Host
$fail = ($results | Where-Object { $_.Result -ne 'PASS' }).Count
Write-Host ("Artifacts: " + $outDir)

if ($started) {
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
        Where-Object { $_.CommandLine -like '*serve.py*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Write-Host 'Server stopped (started by this script)'
}

if ($fail -gt 0) {
    Write-Host ($fail.ToString() + ' case(s) failed') -ForegroundColor Red
    exit 1
}
Write-Host 'All cases passed' -ForegroundColor Green
