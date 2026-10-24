# install-service.ps1 — 注册「登录时自启」的计划任务（被 install.ps1 调用，也可单独跑）
#
# 用法：
#   pwsh -NoProfile -File scripts\install-service.ps1 -Port 8787
#   pwsh -NoProfile -File scripts\install-service.ps1 -Port 8788 -TaskName 'MyGate'
#
# 设计要点：
#   · 只注册任务，不碰环境变量、不装服务、不写注册表、不改 PATH
#   · 解释器用 node 的绝对路径（任务计划程序解析 PATH 用的是服务自己的环境快照，
#     裸名会因「服务启动早于 PATH 变更」报 0x80070002）
#   · key 从 User 级环境变量读：注册时校验一次，不存在就直接报错，避免建出一个必然失败的任务

param(
  [int]$Port = 8787,
  [string]$TaskName = 'OpenCodeDS Route Gate',
  [switch]$Force,
  [switch]$NoStart,
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Entry = Join-Path $Root 'bin\ocg-supervise.mjs'

if (-not (Test-Path $Entry)) { throw "找不到入口: $Entry" }
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw '找不到 node，请先安装 Node 22 LTS' }
$NodeExe = $nodeCmd.Source

$userKey = [Environment]::GetEnvironmentVariable('OPENCODE_GO_API_KEY', 'User')
if (-not $userKey) { throw 'User 级 OPENCODE_GO_API_KEY 未设置。先跑 install.ps1，或 setx OPENCODE_GO_API_KEY "..." 后新开终端。' }

Write-Host "任务名   : $TaskName"
Write-Host "解释器   : $NodeExe"
Write-Host "入口     : $Entry（监护进程，门控退出后 1.5 秒自动拉起）"
Write-Host "工作目录 : $Root"
Write-Host "端口     : $Port"
Write-Host "触发     : 当前用户登录时"

if ($WhatIf) {
  Write-Host ''
  Write-Host '[WhatIf] 以上为将要执行的内容，未做任何改动。'
  return
}

# 清旧任务（同名）——但**不静默覆盖**：
# 同名任务可能指向另一份安装（比如作者本机的旧目录），直接删掉会把别人的生产任务改道。
# 规则：现有任务的参数里包含当前仓库根 → 视为本仓库旧任务，直接替换；
#       否则必须显式 -Force，否则中止并打印对方路径。
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  $existingArg = ''
  try { $existingArg = [string]($existing.Actions | Select-Object -First 1).Arguments } catch {}
  $sameRoot = $existingArg -and $existingArg.Contains($Root)
  if (-not $sameRoot -and -not $Force) {
    throw @"
同名计划任务已存在，且**不是**指向当前目录，未做任何改动：
  任务   : $TaskName
  现有入口: $existingArg
  当前目录: $Root
若确认要用当前目录覆盖它，加 -Force 重跑。
（只想并存就换名字：-TaskName 'OpenCodeDS Route Gate 2'）
"@
  }
  if (-not $sameRoot) { Write-Host "  ! 覆盖既有任务（-Force）：$existingArg" -ForegroundColor Yellow }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "  已移除旧任务：$TaskName"
}

$action = New-ScheduledTaskAction -Execute $NodeExe `
  -Argument ('"{0}" --port {1}' -f $Entry, $Port) -WorkingDirectory $Root

$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

# 实测结论（2026-10-23）：Task Scheduler 的 RestartCount/RestartInterval **不会**在进程退出后
# 重启任务（exit(1) 与外部 kill 各测一次，均未重启），它只管"任务启动失败"这一类。
# 因此真正的重启由 bin\ocg-supervise.mjs 负责；这里保留设置只是兜底，不依赖它。
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description "opencode-ds-route 门控：本地 127.0.0.1:$Port 官方路由校验（登录自启）" | Out-Null

Write-Host ''
Write-Host "已注册计划任务：$TaskName"

if ($NoStart) {
  Write-Host '按 -NoStart 跳过启动（端口上已有本门控在跑，重复启动会与它抢端口）。'
  return
}

# 立即启动并等 health（最多 30s）
try { Start-ScheduledTask -TaskName $TaskName } catch { Write-Warning "启动任务失败: $($_.Exception.Message)" }
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  try {
    $h = Invoke-RestMethod "http://127.0.0.1:$Port/gate/health" -TimeoutSec 2
    if ($h.ok) { $ok = $true; break }
  } catch {}
}
if ($ok) { Write-Host "✅ 门控已在 127.0.0.1:$Port 上运行" }
else { Write-Warning "30 秒内 /gate/health 未就绪，跑 ocg doctor 看原因" }
