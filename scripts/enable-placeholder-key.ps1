# enable-placeholder-key.ps1 — 把 dsh 里门控 provider 的 apiKeyEnv 从真 key 换成占位变量
#
# 目的：门控只用自己的 OPENCODE_GO_API_KEY 打上游，客户端带来的 key 会被覆盖。
#       客户端改用占位值后，真 key 不再经 127.0.0.1 传输（同机其它账户即便抢占端口也拿不到）。
#
# 用法（在 dsh 自己的终端里跑，或任意已继承新环境变量的终端）：
#   pwsh -NoProfile -File scripts\enable-placeholder-key.ps1            # 改 web + desktop
#   pwsh -NoProfile -File scripts\enable-placeholder-key.ps1 -Restore   # 从备份回滚
#
# ⚠ 为什么必须有"环境变量守卫"：
#   2026-10-26 实测事故 —— 先改配置、后设环境变量时，dsh 报
#   `llm-pi-ai: no credential for provider route "ocg-gated-msg"`，该 provider 的模型直接从选择器消失。
#   根因：dsh 只在**自己进程启动时**读环境变量（不读实时系统变量）；而 Windows 每个进程拿到的是
#   父进程的环境快照，所以"设置 User 环境变量"之后，必须由**新启动的父进程**再拉起 dsh 才能看到。
#   本脚本因此先检查"当前进程能不能看到 OCG_PLACEHOLDER_KEY"——它和 dsh 是同一份快照，
#   看不到就说明现在改配置一定会重演那次故障，于是直接拒绝并给出步骤。

param(
  [string[]]$Profiles = @('web', 'desktop'),
  [string]$PlaceholderEnv = 'OCG_PLACEHOLDER_KEY',
  [string]$From = 'OPENCODE_GO_API_KEY',
  [switch]$Restore,
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$Targets = @('ocg-gated', 'ocg-gated-msg')

function Say($m) { Write-Host $m }
function Norm($p) { ([IO.Path]::GetFullPath($p)).TrimEnd('\', '/').ToLowerInvariant() }

# ---------- 回滚 ----------
if ($Restore) {
  $done = 0
  foreach ($name in $Profiles) {
    $f = Join-Path $DshHome "profiles\$name\cordis.patch.yml"
    if (-not (Test-Path $f)) { Say "  跳过（不存在）：$f"; continue }
    $bak = Get-ChildItem (Split-Path $f) -Filter 'cordis.patch.yml.bak-placeholder-*' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $bak) { Say "  跳过（没有备份）：$f"; continue }
    Copy-Item $bak.FullName $f -Force
    Say "  已回滚 $name ← $($bak.Name)"
    $done++
  }
  Say ""
  Say "回滚完成：$done 个 profile。重启 dsh 后生效。"
  exit 0
}

# ---------- 守卫：环境变量必须对当前进程可见 ----------
if (-not [Environment]::GetEnvironmentVariable($PlaceholderEnv)) {
  Say "拒绝执行：当前进程环境里没有 $PlaceholderEnv。"
  Say ""
  Say "原因：dsh 只在启动时读自己的进程环境，而 Windows 给每个进程的是父进程的环境快照。"
  Say "     如果现在改配置，dsh 会报 no credential，且该 provider 的模型从选择器里消失（2026-10-26 实测事故）。"
  Say ""
  Say "正确顺序："
  Say "  1) 设置变量（只需一次）：setx $PlaceholderEnv dummy"
  Say "  2) 让新进程能看到它：注销/重启系统，或重启 Explorer 后再重新打开 dsh"
  Say "  3) 在 dsh 打开后、从 dsh 的终端里重跑本脚本（它会自动校验第 2 步是否真的生效）"
  Say ""
  Say "不想重启 dsh 也可以用 dsh 的 Models 页面：给 ocg-gated / ocg-gated-msg 各存一份凭证，"
  Say "变量名 $PlaceholderEnv、值 dummy。"
  exit 1
}

# ---------- 改配置 ----------
$changedTotal = 0
foreach ($name in $Profiles) {
  $f = Join-Path $DshHome "profiles\$name\cordis.patch.yml"
  if (-not (Test-Path $f)) { Say "  跳过（不存在）：$f"; continue }

  $bytes = [IO.File]::ReadAllBytes($f)
  $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  $text = [IO.File]::ReadAllText($f)
  if ($hasBom) { $text = $text.Substring(1) }
  $crlf = $text.Contains("`r`n")
  $lines = $text -split "`r?`n"
  $origCount = $lines.Count

  $cur = $null; $curIndent = -1; $changed = @()
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    if ($line -match '^(\s+)([A-Za-z0-9_.-]+):\s*$') {
      $indent = $Matches[1].Length; $key = $Matches[2]
      if ($Targets -contains $key) { $cur = $key; $curIndent = $indent }
      elseif ($indent -le $curIndent) { $cur = $null }
    }
    if ($cur -and $line.Trim() -eq "apiKeyEnv: $From") {
      $lines[$i] = $line -replace [regex]::Escape("apiKeyEnv: $From"), "apiKeyEnv: $PlaceholderEnv"
      $changed += ($i + 1)
    }
  }

  if ($changed.Count -eq 0) { Say "  跳过（没找到可改的行）：$name"; continue }
  if ($lines.Count -ne $origCount) { Say "  异常：行数变化，未写入 $name"; continue }

  $out = $lines -join $(if ($crlf) { "`r`n" } else { "`n" })
  $out = $out.TrimEnd("`r", "`n") + $(if ($crlf) { "`r`n" } else { "`n" })
  $bak = "$f.bak-placeholder-$((Get-Date).ToString('yyyyMMddHHmmss'))"

  if ($WhatIf) { Say "  [WhatIf] $name 将改第 $($changed -join ',') 行（备份 $([IO.Path]::GetFileName($bak))）"; continue }

  Copy-Item $f $bak -Force
  [IO.File]::WriteAllText($f, $out, (New-Object System.Text.UTF8Encoding($hasBom)))
  Say "  已改 $name 第 $($changed -join ',') 行（备份 $([IO.Path]::GetFileName($bak))）"
  $changedTotal += $changed.Count
}

if ($WhatIf) { Say ""; Say "[WhatIf] 未写入任何文件。"; exit 0 }

Say ""
if ($changedTotal -eq 0) {
  Say "没有需要改的内容（可能已经是占位值）。"
  exit 0
}
Say "共改 $changedTotal 处。"
Say ""
Say "下一步：重启一次 dsh（配置在启动时加载），然后跑："
Say "  node bin\ocg.mjs doctor        # 应显示 ✅ 客户端 key 占位"
Say ""
Say "回滚：pwsh -NoProfile -File scripts\enable-placeholder-key.ps1 -Restore"
Say "不想用占位 key：把这几行改回 apiKeyEnv: $From（功能不变，只是真 key 会经 127.0.0.1）"
