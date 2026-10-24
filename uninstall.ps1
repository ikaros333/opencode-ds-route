# uninstall.ps1 — 对称卸载（Windows）
#
# 做三件事：停计划任务 → 删计划任务 → 停掉本项目的门控进程
# 不做：删环境变量、删日志（会告诉你它们在哪儿，需要就自己删）

param(
  [int]$Port = 8787,
  [string]$TaskName = 'OpenCodeDS Route Gate',
  [switch]$WhatIf
)

$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot

Write-Host 'opencode-ds-route 卸载'
Write-Host "目录：$Root"

if ($WhatIf) {
  Write-Host ''
  Write-Host '[WhatIf] 将执行：'
  Write-Host "  · 停止并删除计划任务：$TaskName"
  Write-Host "  · 若 127.0.0.1:$Port 上运行的是本门控（/gate/health 应答），结束该进程"
  Write-Host '  · 删除目录下的 stop.flag（若存在）'
  Write-Host '  · 保留：User 环境变量 OPENCODE_GO_API_KEY / GATE_TOKEN、gate\logs 下的日志'
  return
}

# 1) 计划任务
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  # 没显式给 -Port 时，从任务动作里读出安装时用的端口：
  # 否则默认按 8787 去找监听，可能把**另一份安装**（或原项目）的门控杀掉。
  if (-not $PSBoundParameters.ContainsKey('Port')) {
    $actArg = ''
    try { $actArg = [string]($task.Actions | Select-Object -First 1).Arguments } catch {}
    $m = [regex]::Match($actArg, '--port\s+(\d+)')
    if ($m.Success) {
      $Port = [int]$m.Groups[1].Value
      Write-Host "  --  从计划任务参数识别端口：$Port"
    }
  }
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
  try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop; Write-Host "  OK  已删除计划任务 $TaskName" }
  catch { Write-Warning "删除计划任务失败：$($_.Exception.Message)" }
} else {
  Write-Host "  --  计划任务不存在：$TaskName"
}

# 2) 监护进程 + 门控进程：只有 /gate/health 应答才认为是我们的
# 只停本目录的监护进程：别的安装（例如另一份 clone）可能也用同名脚本，
# 按名字一刀切会把别人的门控一起停掉。
$supers = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Root) -and $_.CommandLine -match 'ocg-supervise\.mjs' }
foreach ($s in $supers) {
  try { Stop-Process -Id $s.ProcessId -Force -ErrorAction Stop; Write-Host "  OK  已结束监护进程 PID $($s.ProcessId)" } catch {}
}

# 只认「本门控」的应答：/gate/health 必须同时有 ok=true 与 chain 数组。
# 只看 ok=true 的话，任何在该端口返回 {"ok":true} 的程序都会被当成我们，进而被结束。
$isOurs = $false
try {
  $h = Invoke-RestMethod "http://127.0.0.1:$Port/gate/health" -TimeoutSec 2
  $isOurs = [bool]$h.ok -and (@($h.chain).Count -gt 0)
} catch {}

if ($isOurs) {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) {
    try { Stop-Process -Id $conn.OwningProcess -Force -ErrorAction Stop; Write-Host "  OK  已结束门控进程 PID $($conn.OwningProcess)" }
    catch { Write-Warning "结束进程失败：$($_.Exception.Message)" }
  }
} elseif (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  Write-Host "  --  端口 $Port 上有别的程序在监听（不是本门控），未动它"
} else {
  Write-Host "  --  端口 $Port 上没有监听"
}

# 3) 哨兵文件
$flag = Join-Path $Root 'stop.flag'
if (Test-Path $flag) { Remove-Item $flag -Force -ErrorAction SilentlyContinue; Write-Host '  OK  已删除 stop.flag' }

Write-Host ''
Write-Host '卸载完成。以下内容仍保留（需要就自己删）：'
Write-Host "  · User 环境变量：OPENCODE_GO_API_KEY / GATE_TOKEN"
Write-Host '      setx OPENCODE_GO_API_KEY ""   （空值会删除该变量）'
Write-Host "  · 日志与快照：$(Join-Path $Root 'gate\logs')"
