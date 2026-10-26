# install.ps1 — 一次性安装向导（Windows）
#
# 用法（在 PowerShell 里）：
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -WhatIf     # 只看会做什么
#   pwsh -NoProfile -File .\install.ps1 -Port 8788 -NoTask
#
# 会做的三件事（也只做这三件）：
#   1. 把 key / 可选 token 写进「User 级环境变量」（不写文件、不写注册表其它位置）
#   2. 注册一个「登录时启动」的计划任务（可用 -NoTask 跳过）
#   3. 启动并验证 /gate/health
# 不会：装 Node、改 PATH、装服务、下载任何东西、杀你机器上别的进程。

param(
  [int]$Port = 8787,
  [string]$TaskName = 'OpenCodeDS Route Gate',
  [switch]$NoTask,
  [switch]$NoToken,
  [switch]$Force,
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Entry = Join-Path $Root 'bin\ocg.mjs'

function Say($m) { Write-Host $m }
function Step($n, $t) { Write-Host ""; Write-Host "[$n/5] $t" -ForegroundColor Cyan }

Say "opencode-ds-route 安装向导"
Say "目录：$Root"
Say "平台：仅 Windows（Linux/macOS 不保证可用）"

if ($WhatIf) {
  Say ""
  Say "[WhatIf] 将执行以下动作（不做任何改动）："
  Say "  1. 检查 Node ≥ 22"
  Say "  2. 把 OPENCODE_GO_API_KEY 写入 User 环境变量（若尚未设置，会先向你要一次）"
  Say "  3. 生成并写入 User 环境变量 GATE_TOKEN（本地鉴权，可用 -NoToken 关闭此步骤）"
  Say "  4. 使用端口 $Port（若被占用会提示换端口，不会结束占用进程）"
  if ($NoTask) { Say "  5. 跳过计划任务（-NoTask）" }
  else { Say "  5. 注册计划任务 '$TaskName'：登录时启动监护进程（门控退出后 1.5 秒自动拉起）" }
  Say ""
  Say "不会：安装 Node、修改 PATH、写注册表其它项、安装 Windows 服务、下载外部文件。"
  Say "同名任务若指向别的目录，会中止并要求 -Force（不会静默覆盖）。"
  return
}

# ---------------- 1. Node ----------------
Step 1 '检查 Node'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  throw '没找到 Node。请安装 Node 22 LTS（https://nodejs.org/）后重新打开终端再跑本脚本。'
}
$verText = (& node --version).Trim()
$major = [int](($verText.TrimStart('v') -split '\.')[0])
if ($major -lt 22) { throw "Node 版本过低：$verText（需要 ≥ 22）。请升级后重试。" }
Say "  OK  Node $verText"

# ---------------- 2. key ----------------
Step 2 '检查 API key'
$key = [Environment]::GetEnvironmentVariable('OPENCODE_GO_API_KEY', 'User')
if (-not $key) {
  Say '  未检测到 User 级 OPENCODE_GO_API_KEY。'
  Say '  key 只用于向 opencode.ai 发起请求；本程序不缓存、不写日志、不向外转发。'
  if ([Console]::IsInputRedirected) {
    throw '缺少 OPENCODE_GO_API_KEY，且当前不是交互式终端（无法询问）。请先 setx OPENCODE_GO_API_KEY "..." 再重跑。'
  }
  $sec = Read-Host -AsSecureString '  粘贴你的 OpenCode Go key（输入不回显）'
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  $plain = ($plain -as [string]).Trim()
  if ($plain.Length -lt 10) { throw 'key 看起来太短，未保存。' }
  [Environment]::SetEnvironmentVariable('OPENCODE_GO_API_KEY', $plain, 'User')
  $key = $plain
  Say "  OK  已写入 User 环境变量（长度 $($key.Length)）"
} else {
  Say "  OK  已存在（长度 $($key.Length)）"
}

# 客户端占位 key（R1）：门控只用自己的 OPENCODE_GO_API_KEY，dsh 侧用占位值即可，
# 真 key 就不必经过 127.0.0.1（同机其它账户即便抢占端口也拿不到）。
if (-not [Environment]::GetEnvironmentVariable('OCG_PLACEHOLDER_KEY', 'User')) {
  [Environment]::SetEnvironmentVariable('OCG_PLACEHOLDER_KEY', 'dummy', 'User')
  Say '  OK  已写入 OCG_PLACEHOLDER_KEY=dummy（dsh 侧的占位 key；门控不使用它）'
  Say '      ⚠ dsh 只在启动时读环境变量：装完请重启 dsh，否则该 provider 会报 no credential、模型消失'
} else {
  Say '  OK  OCG_PLACEHOLDER_KEY 已存在（占位 key）'
}
# ---------------- 3. 端口 ----------------
Step 3 "检查端口 $Port"
$alreadyRunning = $false
function Test-Listening([int]$p) {
  try { return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop) } catch { return $false }
}
if (Test-Listening $Port) {
  # 是我们的门控就继续；是别人的就要求换端口（绝不结束别人的进程）
  $h = $null
  try { $h = Invoke-RestMethod "http://127.0.0.1:$Port/gate/health" -TimeoutSec 2 } catch {}
  $isOurs = [bool]($h -and $h.ok)
  # 归属校验（2026-10-26）：health.ok 只能说明「这个端口上有门控」，不能说明「跑的是当前目录这份」。
  # 同机两份安装时，改了代码却不生效，根因就在这里。root 归一后比较（Windows 路径大小写不敏感）。
  if ($isOurs -and $h.root) {
    $norm = { param($p) (([IO.Path]::GetFullPath([string]$p)).TrimEnd('\', '/')).ToLowerInvariant() }
    if ((& $norm $h.root) -ne (& $norm $Root)) {
      Say "  注意：这个端口上跑的是另一份安装：$($h.root)"
      Say "        当前目录：$Root —— 在这份里改代码不会生效。"
      $isOurs = $false
    }
  }
  if ($isOurs) {
    $alreadyRunning = $true
    Say '  已有门控在这个端口上运行，稍后只注册任务、不重复启动（避免抢端口）。'
  } else {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    $procName = '?'
    if ($conn) { try { $procName = (Get-Process -Id $conn.OwningProcess -ErrorAction Stop).ProcessName } catch {} }
    Say "  端口被占用：PID $($conn.OwningProcess) ($procName)。本脚本不会结束它。"
    $portInput = $null
    if ([Console]::IsInputRedirected) {
      throw "端口 $Port 被占用（不是本门控）。当前不是交互式终端，无法询问新端口；请用 -Port <空闲端口> 重跑。"
    }
    $portInput = Read-Host "  换一个端口（回车用 8788）"
    if ([string]::IsNullOrWhiteSpace($portInput)) { $Port = 8788 } else { $Port = [int]$portInput }
    if (Test-Listening $Port) { throw "端口 $Port 也被占用，请手动挑一个空闲端口后重跑：-Port <端口>" }
    Say "  OK  改用 $Port"
  }
} else {
  Say '  OK  空闲'
}

# ---------------- 4. 本地鉴权 token ----------------
Step 4 '本地鉴权 token（可选，但推荐）'
$token = [Environment]::GetEnvironmentVariable('GATE_TOKEN', 'User')
if ($NoToken) {
  Say '  按 -NoToken 跳过：任何本机进程都能直接使用你的 key 配额。'
  $token = ''
} elseif (-not $token) {
  $token = 'tok_' + ([guid]::NewGuid().ToString('N').Substring(0, 24))
  [Environment]::SetEnvironmentVariable('GATE_TOKEN', $token, 'User')
  # 不回显 token：终端 scrollback / 截图 / 录屏会把 token 一起带出去。
  # 需要时用 $env:GATE_TOKEN（新开终端）或下面的读取命令。
  Say '  OK  已生成并写入 User 环境变量 GATE_TOKEN（不回显）'
  Say '      取用：$env:GATE_TOKEN   或   [Environment]::GetEnvironmentVariable("GATE_TOKEN","User")'
  if ($alreadyRunning) { Say '  注意：门控已在运行，token 要等门控重启后才生效。' }
} else {
  Say '  OK  已存在（不回显；取用：$env:GATE_TOKEN）'
}

# ---------------- 5. 计划任务 + 启动 ----------------
Step 5 '注册计划任务并启动'
if ($NoTask) {
  Say '  按 -NoTask 跳过。手动启动：双击 start.cmd，或 npm start'
} else {
  $svc = Join-Path $Root 'scripts\install-service.ps1'
  & $svc -Port $Port -TaskName $TaskName -Force:$Force -NoStart:$alreadyRunning
}

Write-Host ''
Say '  说明：计划任务拉起的是 bin\ocg-supervise.mjs（监护进程），'
Say '        门控崩溃/被杀后 1.5 秒自动重启。Task Scheduler 自带的 RestartCount 实测无效，已不依赖它。'

# key 在当前会话里也生效（方便紧接着体检）
$env:OPENCODE_GO_API_KEY = $key
if ($token) { $env:GATE_TOKEN = $token }
$env:GATE_PORT = [string]$Port

# ---------------- 体检 ----------------
Write-Host ''
Write-Host '--- 体检 ---' -ForegroundColor Cyan
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  try { $h = Invoke-RestMethod "http://127.0.0.1:$Port/gate/health" -TimeoutSec 2; if ($h.ok) { $ok = $true; break } } catch {}
  Start-Sleep -Seconds 1
}
if ($ok) {
  $st = if ($h.startupSelfTest -and $h.startupSelfTest.verdict) { $h.startupSelfTest.verdict } else { 'pending' }
  Say "OK  /gate/health ok=true（port=$Port, selftest=$st）"
} else {
  Say "!!  /gate/health 未就绪。手动跑：node bin\ocg.mjs doctor"
}

# ---------------- 下一步 ----------------
$hdr = if ($token) { '  请求头: x-gate-token: $env:GATE_TOKEN（新开终端后可用）' } else { '  （未启用本地鉴权）' }
Write-Host ''
Write-Host '--- 下一步：把客户端指到门控 ---' -ForegroundColor Cyan
Say "  responses 协议:  http://127.0.0.1:$Port/v1"
Say "  messages 协议 :  http://127.0.0.1:$Port      （不带 /v1）"
Say $hdr
Say '  dsh 用户可以直接跑：node bin\ocg.mjs setup dsh'
Write-Host ''
Say '  日常自查：node bin\ocg.mjs doctor'
Say '  出问题  ：node bin\ocg.mjs diag   （脱敏，可直接贴 issue）'
Say "  卸载    ：powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Port $Port -TaskName '$TaskName'"
