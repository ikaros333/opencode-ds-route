# regress.ps1 — 生产回归：起一个「影子门控」打真实上游，跑成套测试
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\regress.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\regress.ps1 -IncludeSoak   # 会烧配额
#   pwsh -NoProfile -File scripts\regress.ps1 -ShadowPort 8799
#   pwsh -NoProfile -File scripts\regress.ps1 -NodeExe 'C:\tools\node22\node.exe'   # 指定运行时
#
# 不需要 key 的部分（gate\verify-patch.mjs、gate\test-coverage.mjs）在第一步就跑了；
# 之后才会读 User 级 OPENCODE_GO_API_KEY，没有就跳过真实上游那一批。

param(
  [switch]$IncludeSoak,
  [int]$ShadowPort = 8799,
  [string]$NodeExe = 'node'
)

$ErrorActionPreference = 'Continue'

# 原生命令输出解码：PS 5.1 用控制台代码页(GBK)解码 node 的 UTF-8 输出 → 中文全变乱码。
# 显式声明 UTF-8 后 node 的 stdout/stderr 可直读（这条在中文 Windows 上必踩）。
try {
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  $OutputEncoding = [Text.UTF8Encoding]::new($false)
} catch {}

# 解析 node 可执行文件：允许传绝对路径（验证不同 Node 版本用）
$nodeCmd = Get-Command $NodeExe -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw "找不到可执行文件: $NodeExe" }
$NodePath = $nodeCmd.Source

$Root = Split-Path -Parent $PSScriptRoot
$Gate = Join-Path $Root 'gate\oc-gate.mjs'
$LogDir = Join-Path $Root 'gate\logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Write-Host ('=== 0. 脚本编码检查（Windows 专属坑）=== 运行时: ' + (& $NodePath --version))
# .ps1 必须「带 UTF-8 BOM」或「纯 ASCII」：PS 5.1 在中文 Windows 按 GBK 解码无 BOM 脚本，
# GBK 尾字节 0x5C 就是反斜杠，会转义掉后面的引号 → 解析失败 → 计划任务起不来 → 门控整个没起。
$bad = @()
Get-ChildItem $Root -Recurse -File -Include *.ps1 |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' } | ForEach-Object {
    $b = [IO.File]::ReadAllBytes($_.FullName)
    $hasBom = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
    $nonAscii = $false
    foreach ($byte in $b) { if ($byte -gt 0x7F) { $nonAscii = $true; break } }
    if (-not $hasBom -and $nonAscii) { $bad += $_.Name }
  }
if ($bad.Count -eq 0) { Write-Host '  PASS  .ps1 编码安全（有 BOM 或纯 ASCII）' }
else { Write-Host ('  FAIL  ' + ($bad -join ', ') + ' —— 缺 BOM 且含非 ASCII') }

$badVbs = @()
Get-ChildItem $Root -Recurse -File -Include *.vbs -ErrorAction SilentlyContinue | ForEach-Object {
  $b = [IO.File]::ReadAllBytes($_.FullName)
  if (($b | Where-Object { $_ -gt 0x7F } | Select-Object -First 1) -ne $null) { $badVbs += $_.Name }
}
if ($badVbs.Count -eq 0) { Write-Host '  PASS  .vbs 纯 ASCII（无文件则通过）' }
else { Write-Host ('  FAIL  ' + ($badVbs -join ', ') + ' 含非 ASCII') }

Write-Host ''
Write-Host '=== 1. 离线检查 ==='
& $NodePath (Join-Path $Root 'gate\verify-patch.mjs')
if ($LASTEXITCODE -ne 0) { Write-Host '  源码自检失败，停止回归'; exit 1 }
& $NodePath (Join-Path $Root 'gate\test-coverage.mjs')
if ($LASTEXITCODE -ne 0) { Write-Host '  覆盖套件失败，停止回归'; exit 1 }

Write-Host ''
Write-Host '=== 2. 真实上游回归 ==='
$key = [Environment]::GetEnvironmentVariable('OPENCODE_GO_API_KEY', 'User')
if (-not $key) { $key = $env:OPENCODE_GO_API_KEY }
if (-not $key) {
  Write-Host '  跳过：没有 OPENCODE_GO_API_KEY（这一批会打真实上游、消耗配额）'
  exit 0
}

# 影子门控：独立端口、独立台账、每请求实测（不吃生产 TTL）
$env:OPENCODE_GO_API_KEY = $key
$env:GATE_PORT = [string]$ShadowPort
$env:GATE_REFRESH_MS = '0'
$env:GATE_PRECHECK_TTL_MS = '0'
$env:GATE_TOTAL_BUDGET_MS = '60000'   # 测试自己钉住预算：断言里的 <70s / max<60000 不依赖生产默认值
$env:GATE_BLOCK_PROTOS = 'chat'
$env:GATE_PROOF_MODE = 'monitor'
$env:GATE_SNAPSHOT = Join-Path $LogDir 'shadow-matrix.json'
# 2026-10-29：生产门控已启用 GATE_TOKEN。影子门控继承同一个值，测试脚本也从
# process.env.GATE_TOKEN 读取并发送（见各 test-*.mjs 的 headers）。
# 这样即使某个套件回落到默认端口 8787（生产门控），也能正常鉴权，不会出现「设了 token 却 401」。
if (-not $env:GATE_TOKEN) {
  $tok = [Environment]::GetEnvironmentVariable('GATE_TOKEN', 'User')
  if ($tok) { $env:GATE_TOKEN = $tok }
}
$env:GATE_LOG_FILE = Join-Path $LogDir 'shadow-gate.jsonl'

$shadow = Start-Process $NodePath -ArgumentList $Gate -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $LogDir 'shadow-out.log') `
  -RedirectStandardError (Join-Path $LogDir 'shadow-err.log')
$base = "http://127.0.0.1:$ShadowPort"
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  try { $h = Invoke-RestMethod "$base/gate/health" -TimeoutSec 2; if ($h.ok) { $ready = $true; break } } catch {}
}
if (-not $ready) {
  Write-Host "  影子门控没起来，看 $(Join-Path $LogDir 'shadow-err.log')"
  try { Stop-Process -Id $shadow.Id -Force } catch {}
  exit 1
}
Write-Host "  影子门控就绪：$base  tokenRequired=$($h.tokenRequired)  envToken=[" + $env:GATE_TOKEN + "]"

$fail = 0
function Run([string]$name, [string[]]$args) {
  Write-Host ''
  Write-Host "--- $name ---"
  & $NodePath (Join-Path $Root "gate\$name") @args
  if ($LASTEXITCODE -ne 0) { $script:fail++; Write-Host "  FAIL  $name" -ForegroundColor Red }
}

Run 'test-suite.mjs'      @($base)
Run 'test-pollution.mjs'  @($base)
Run 'test-security.mjs'   @($base)
Run 'test-cache.mjs'      @($base)
Run 'test-multimodal.mjs' @($base)
Run 'test-real.mjs'       @($base)
if ($IncludeSoak) { Run 'test-risk.mjs' @([string]$ShadowPort) }
else { Write-Host ''; Write-Host '--- test-risk.mjs（跳过 soak，用 -IncludeSoak 开启）---' }

try { Stop-Process -Id $shadow.Id -Force } catch {}
Get-NetTCPConnection -LocalPort $ShadowPort -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { try { Stop-Process -Id $_.OwningProcess -Force } catch {} }

Write-Host ''
if ($fail -eq 0) { Write-Host '===== 真实上游回归：全部通过 =====' -ForegroundColor Green; exit 0 }
else { Write-Host "===== 真实上游回归：$fail 套失败 =====" -ForegroundColor Red; exit 1 }
