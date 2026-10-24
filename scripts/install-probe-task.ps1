# 注册「官方性探针」计划任务（Windows，每 10 分钟一次）
# 用法：pwsh -NoProfile -File scripts\install-probe-task.ps1
#       powershell -ExecutionPolicy Bypass -File scripts\install-probe-task.ps1
#
# 说明：本脚本从自身位置推导仓库根目录，不依赖任何固定盘符。
#       key 从「用户级环境变量 OPENCODE_GO_API_KEY」读取，不外传、不落盘。

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$TaskName = 'OpenCodeDS Official Probe'
$Node = (Get-Command node -ErrorAction Stop).Source
$Probe = Join-Path $Root 'probe\official-detect.mjs'
$Log = Join-Path $Root 'probe\probe-task.log'
$ProofFile = Join-Path $Root 'gate\logs\official-proof.json'

if (-not (Test-Path $Probe)) { throw "探针脚本不存在: $Probe" }
foreach ($d in @((Split-Path $Log), (Split-Path $ProofFile))) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}

# 先验证 key 能否被读到（用户级环境变量）
$userKey = [Environment]::GetEnvironmentVariable('OPENCODE_GO_API_KEY', 'User')
if (-not $userKey) { throw '用户级 OPENCODE_GO_API_KEY 未设置，探针无法运行' }
Write-Host "用户级 key 已确认（长度 $($userKey.Length)）"

# 清旧任务
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }

# 用 PowerShell 包装：隐藏窗口 + 输出重定向 + 显式注入 key（S4U 环境下用户环境变量不可见）
$inner = @"
`$env:OPENCODE_GO_API_KEY = [Environment]::GetEnvironmentVariable('OPENCODE_GO_API_KEY','User')
& '$Node' '$Probe' --target=opencode *>> '$Log'
"@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))

# 解释器选择：优先 pwsh 7 绝对路径；没有就退回 powershell.exe（此时要求脚本为纯 ASCII 或带 BOM）
$pwshCmd = Get-Command pwsh.exe -ErrorAction SilentlyContinue
$taskExe = if ($pwshCmd) { $pwshCmd.Source } else { (Get-Command powershell.exe).Source }
Write-Host "任务解释器: $taskExe"

$action = New-ScheduledTaskAction -Execute $taskExe `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encoded"

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 365)

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -Hidden

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description '周期验证 OpenCode Go 后端是否为官方未量化 DeepSeek 模型；结果写入 gate/logs/official-proof.json' | Out-Null

Write-Host "已注册: $TaskName （每 10 分钟，隐藏窗口）"

# 立即跑一次验证
Write-Host "立即执行验证..."
$beforeTs = $null
if (Test-Path $ProofFile) { $beforeTs = (Get-Content $ProofFile -Raw | ConvertFrom-Json).ts }

Start-ScheduledTask -TaskName $TaskName
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  if (Test-Path $ProofFile) {
    $now = (Get-Content $ProofFile -Raw | ConvertFrom-Json).ts
    if ($now -ne $beforeTs) { break }
  }
}

$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host "  LastRunTime : $($info.LastRunTime)"
Write-Host "  LastResult  : $($info.LastTaskResult)"

if (Test-Path $ProofFile) {
  $p = Get-Content $ProofFile -Raw | ConvertFrom-Json
  Write-Host ""
  Write-Host "proof 状态:"
  Write-Host "  ts      = $($p.ts)  (更新前: $beforeTs)"
  Write-Host "  verdict = $($p.verdict)   trust = $($p.trust)"
  Write-Host "  pass=$($p.pass) fail=$($p.fail) unknown=$($p.unknown) / $($p.total)"
  Write-Host "  成本    = $($p.cost.tokens) token / $($p.cost.calls) 次调用"
  if ($p.ts -eq $beforeTs) {
    Write-Warning "proof 未更新，请检查 $Log"
  } else {
    Write-Host "  ✅ proof 已刷新"
  }
}
