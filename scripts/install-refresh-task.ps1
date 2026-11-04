# 安装「证据自动刷新」计划任务（Windows）
#
# 作用：每小时跑一次 ocg audit-lane --write，刷新 gate/logs/lane-evidence.json。
# 为什么必须：GATE_CANARY_POLICY=require 依据的是快照；快照过期会 fail-closed 拒掉全部流量。
#
# 用法（在仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File scripts\install-refresh-task.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-refresh-task.ps1 -Uninstall
#   powershell -ExecutionPolicy Bypass -File scripts\install-refresh-task.ps1 -IntervalMinutes 30

[CmdletBinding()]
param(
  [string]$TaskName = 'ocg-evidence-refresh',
  [int]$IntervalMinutes = 60,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir = Join-Path $repo 'gate\logs'
$logFile = Join-Path $logDir 'audit-refresh.log'

if ($Uninstall) {
  schtasks /delete /tn $TaskName /f 2>$null | Out-Null
  Write-Host "[ok] 已删除计划任务 $TaskName"
  exit 0
}

# --- 前置检查 ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "[bad] 找不到 node（需要 Node >= 22）" -ForegroundColor Red; exit 1
}
foreach ($v in 'DEEPSEEK_API_KEY', 'OPENCODE_GO_API_KEY') {
  if (-not [Environment]::GetEnvironmentVariable($v, 'User')) {
    Write-Host "[bad] 用户级环境变量 $v 未设置（计划任务读不到交互终端的环境）" -ForegroundColor Red
    Write-Host "      setx $v `"<你的 key>`"  然后新开终端" ; exit 1
  }
}
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

# --- 持久化车道配置（计划任务不继承交互终端的 GATE_* ）---
# 仅在用户级未设置时补默认值，避免覆盖你自己的配置。
$defaults = @{
  GATE_HOST             = 'opencode.ai'
  GATE_CHAIN            = 'deepseek-v4.1-flash'
  GATE_UPSTREAM_PREFIX  = '/zen/go'
  GATE_EVIDENCE_MAX_AGE_MS = '7200000'   # 2 小时：允许一次刷新失败而不至于全拒
}
foreach ($k in $defaults.Keys) {
  $cur = [Environment]::GetEnvironmentVariable($k, 'User')
  if (-not $cur) {
    [Environment]::SetEnvironmentVariable($k, $defaults[$k], 'User')
    Write-Host "[set] $k = $($defaults[$k])"
  } else {
    Write-Host "[keep] $k = $cur"
  }
}

# --- 注册任务 ---
# 关键：audit-lane 在「非官方车道」上退出码是 2（表示端点不是官方，不是故障），
# 末尾必须 & exit 0，否则计划任务每小时都显示"失败"，把真正的故障掩盖掉。
$cmd = 'cmd /c cd /d "' + $repo + '" && node bin\ocg.mjs audit-lane --write >> "' + $logFile + '" 2>&1 & exit 0'

schtasks /create /tn $TaskName /tr $cmd /f /sc minute /mo $IntervalMinutes 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "[bad] schtasks 创建失败（可能需要管理员权限，或任务名已被占用）" -ForegroundColor Red
  exit 1
}

Write-Host "[ok] 已创建计划任务 $TaskName（每 $IntervalMinutes 分钟）"
Write-Host "     命令: $cmd"
Write-Host "     日志: $logFile"
Write-Host ""
Write-Host "立即验证一次："
Write-Host "  schtasks /run /tn $TaskName"
Write-Host "  约 60~90 秒后查看 gate\logs\lane-evidence.json 的 at 字段是否更新"
Write-Host '  以及门控 health：curl -H "x-gate-token: $env:GATE_TOKEN" http://127.0.0.1:8787/gate/health'
