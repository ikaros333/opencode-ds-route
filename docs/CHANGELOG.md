# CHANGELOG

变更标注三类影响面：**网络**（出网行为/判据）、**文件**（读写路径）、**env**（环境变量）。
触碰网络或 env 的版本会在 Release 说明里单独置顶。

## 0.1.0 — 2026-10-23

首个公开版本。基线版本，非官方项目。

### 相对作者本机版本的变化（整理进公开仓库）

- **文件**：`gate/`、`probe/` 全部去掉硬编码盘符，改为 `import.meta.dirname` 推导；
  `bin/ocg.mjs` 在 Windows 下改用 `pathToFileURL` 动态 import（原先直接传盘符路径会报
  `ERR_UNSUPPORTED_ESM_URL_SCHEME`）。
- **网络**：判据常量抽到 `gate/baseline.mjs` 单一来源，`gate` 与 `probe` 共用；
  `verify-patch` 新增断言，禁止任一文件再复制常量字面量。
  修复了此前"预检说 pass、交付却 503"的漂移隐患。
- **env**：新增 `GATE_TOKEN`（可选本地鉴权）。留空即关闭；`install.ps1` 默认生成并启用。
  动机：绑回环不等于安全，本机任意进程都能打 8787 白嫖 key 配额。
- **env**：新增 `GATE_TRACE=1`，把每次出网目标打到 stderr（只有 host:port + path）。
- **网络**：`/gate/health` 新增 `judgeAgeMs` / `lastJudgeOk` / `egressHost` /
  `tokenRequired` / `baselineObservedAt`，让"保护状态"对用户可见。
- **文件**：`gate/test-coverage.mjs` 改为自适应端口（8810/8910 被占不再误判为项目坏了）；
  新增 G10（本地鉴权）、G11（health 判据字段）两个用例，回归从 36 条增至 48 条。
- **文件**：`verify-patch` 从 240 条断言增至 271 条（下文各轮增量累计）。
- **env**：`engines` 提升为 Node ≥ 22（20 系列已近 EOL；实际只在 24 上验证过）。

### 文档

- `.gitignore` 补全：`.env.*`（保留 `!.env.example`）、`.npmrc`、`cordis.patch.yml*`、
  `*.pem/*.key/*.pfx/*.p12`、`id_rsa/id_ed25519`、`session.txt`、`*.zip/*.tgz/*.tar.gz`、
  `ocg-diag*`、`*.tmp`、`.claude/`、`desktop.ini`。
  用 26 个"不该上传"的样例文件做过 `git add -A` 验证：全部被忽略，`.env.example` 仍被跟踪。

- README 的「下载与安装」「接到 dsh」两节按同类项目的写法重写：
  **先决条件 → 分步（每步一个动作 + 期望结果）→ 验证 → 卡住了**。
  安装侧补：下载/解压/在目录打开 PowerShell、`Unblock-File` 与 `-ExecutionPolicy Bypass`
  对应的两种报错、安装脚本做的 5 件事、新开终端再验证。
  dsh 侧补：兼容性门槛（≥ `0.2.0-rc.2`）、provider 级 YAML 片段（不再从 `- id:` 开始贴）、
  插入位置与"不要新加第二个 `llm-pi-ai`"、重启 dsh 引擎的方法、
  `dsh --profile web --dump-config | Select-String ocg-gated` 与模型选择器两处验证、回滚、4 行排障表。
- `docs/DSH.md` 增加「改完怎么重启」「打开配置文件」「兼容性」三节。
- 新增 `docs/FAQ.md`（按症状分节，含 503 各 `error.type` 的处置）与
  `docs/DISCLAIMER.md`（免责声明完整版 + 英文摘要）；README 只留 4 条要点和链接。
- 新增 `SECURITY.md`（怎么报、什么不算安全问题）与 `CONTRIBUTING.md`
  （仓库结构、开发环境、三个必知的坑、PR 检查单）。
- `docs/OPERATIONS-zh.md` 顶部加 13 节目录（锚点已自检对应）。
- README 增加[免责声明](../README.md#免责声明)：明确与 OpenCode / DeepSeek 无关联；说明本工具不改路由、
  只在本地筛选响应，但"按上游身份筛选"的用法可能触及服务条款并影响第三方利益；声明不提供担保，
  并把使用边界限定为单机、自用、单 key。

### 安全审查（2026-10-23，第二轮）

| 项 | 结论 |
|---|---|
| **发现并修复**：`.env` 从当前工作目录加载 | 在别人放好 `.env` 的目录里运行 `ocg`，`GATE_HOST` 可被改写到攻击者主机，prompt 随之外发。现在只读仓库根 `.env`。 |
| **发现并修复**：跨域 no-cors 借道（CSRF） | 页面可以用 `text/plain` 往 127.0.0.1 发 JSON，门控照单全收 → 没开 `GATE_TOKEN` 时可被借额度。现在非 `application/json` 一律 415。 |
| **发现并修复**：DNS rebinding | `evil.com` 解析到 127.0.0.1 时 Host 仍是 evil.com，门控原样受理。现在只认 `127.0.0.1` / `localhost` / `[::1]` 的 Host，否则 421。**第三轮补**：当时校验位置在 `/gate/*` 出口之后，观测端点仍可被 rebind 读取，已上移。 |
| 发布身份泄漏 | 本机 `git config --global user.email` 是真实个人邮箱，首次提交会写进每个 commit。PUBLISH 增加必做步骤：仓库级改成 GitHub noreply 地址。 |
| 已复查无问题 | key 不落盘、prompt 不进台账、`diag` 脱敏（含 `oc_sk_`）、token 常量时间比较、只绑回环、TLS 默认校验、日志/备份/`.env` 均被 `.gitignore` 覆盖 |

新增断言 V21/V22（JSON content-type、回环 Host），自检 267 → 271；`test-security` 增加 S10/S11/S12，20 项全通过。

### 安全审查（2026-10-23，第三轮）

公开发布前的红队视角复核：把自己当成"看到仓库就想搞事的人"，逐个出口实测。

| 项 | 结论 |
|---|---|
| **发现并修复**：Host 校验在 `/gate/*` 之后（DNS rebinding 绕过） | 上一轮把回环 Host 校验放进了 `if (isProxy)` 分支，而 `/gate/health`、`/gate/proof`、`/gate/alerts`、`/gate/metrics`、`/gate/matrix`、`/gate/latency` 都定义在它**前面**。实测 `curl -H 'Host: evil.example' http://127.0.0.1:8787/gate/proof` 返回 **200**：`evil.com` rebind 到 127.0.0.1 后页面仍是同源，可直接读走响应体。现校验上移到 `handle()` 最前面，覆盖全部出口；`/v1/*` 仍返回 421。 |
| **发现并修复**：`/gate/proof` 回传本机绝对路径 | 响应里 `file: PROOF_FILE` 是 `C:\...\gate\logs\official-proof.json`，与"不泄漏本机路径"的口径矛盾（也违反 V23 的同类要求）。改为只回 `path.basename()`。 |
| **发现并修复**：`install.ps1` 明文回显 `GATE_TOKEN` | 安装完把 token 打到屏幕上（新建与已存在两种情况都打），终端 scrollback / 截图 / 录屏会把它带出去。改为不回显，只提示用 `$env:GATE_TOKEN` 取。 |
| **发现并修复**：`uninstall.ps1` 只凭 `{"ok":true}` 认领进程 | 端口上任何返回 `ok=true` 的程序都会被当成门控并结束。现在要求 `/gate/health` 同时带 `chain` 数组（本门控独有字段）。 |
| **发现并修复**：`npm pack` 把运行产物打进包 | `package.json` 的 `files` 写的是目录 `gate/`，会覆盖 `.gitignore`：实测打包包含 `gate/logs/gate.jsonl`（53.8 KB）、`session.txt`、`cov-*.json`，共 52 个文件。改为显式 glob，现 39 个文件、0 命中。 |
| **发现并修复**：`git init` 默认分支是 `master` | 本机 `init.defaultBranch=master`，PUBLISH 里的 `push -u origin main` 会直接失败。改为 `git init -b main` + 分支校验。 |
| 已复查无问题 | key 只在内存与出网请求头里；`diag` 脱敏覆盖 `oc_sk_`/`sk-`/`tok_`/`Bearer`/`ses_`/盘符路径；请求体 16MB 上限按流式累计（chunked 也拦）；路径白名单先于读 body；计划任务 `RunLevel Limited`（不提权）；任务 XML 不含 key；仅绑 `127.0.0.1`；未关 TLS 校验；无第三方依赖 |
| 接受的风险（已写入 README） | 同用户的本机恶意进程可读 User 环境变量里的 key，`GATE_TOKEN` 只挡"不知道 token 的进程"，挡不住同用户恶意软件；蓄意 TLS 中间人可复刻全部可观测特征 |

新增断言 V25（Host 校验必须早于 `/gate/*` 出口，顺序断言）、V26（`/gate/proof` 不得回传绝对路径）；`test-coverage` 新增 G12（非回环 Host 读 `/gate/health`、`/gate/proof` 必须 421，回环 Host 仍 200）。自检 271 → 273，覆盖 48 → 53。

`.gitignore` 补 `.cursor/`、`.fleet/`、`*.code-workspace`、`*.orig`、`*.rej`、`*.pid`、`*.stackdump`、`*.dmp`、`coverage/`、`.nyc_output/`、`*.crt`、`*.cer`、`*.der`；用 11 个"不该上传"的样例文件复验，`git add -A` 后全部被忽略。

### 安全审查（2026-10-23，第一轮）

| 项 | 结论 |
|---|---|
| key / token 是否落盘 | 否。gate 只从环境变量读，不写日志/快照/响应；`diag` 脱敏 |
| **发现并修复**：401 台账写入整条 URL | 客户端把 token 误放进 `?x-gate-token=` 时，`path: req.url` 会把 token 写进 `gate.jsonl`。现只记 `pathname`（`String(req.url).split('?')[0]`） |
| **发现并修复**：`diag` 脱敏漏掉 `oc_sk_` 形态 | 旧规则只匹配 `sk-`，而真实 key 形如 `oc_sk_...`，会原样出现在诊断摘要里。现补齐 `oc_sk_` / `sk-` / `tok_` / `Bearer` |
| token 比较 | 改为 `crypto.timingSafeEqual`（等长才比较） |
| 监听范围 | `server.listen(PORT, '127.0.0.1')`，不绑 `0.0.0.0` |
| TLS | 未关闭证书校验（未出现 `rejectUnauthorized: false`） |
| 请求体 | 上限 16MB，超限 413；台账不记录正文 |
| 计划任务 | XML 中不含 key（任务只继承 User 环境变量） |
| 归档内容 | `git archive` 只含已跟踪文件，无 `.git` / `logs` / `.env` / 用户路径；时间戳统一为提交时间 |

新增断言 V18–V20（台账剥离 query、禁止整条 URL 入账、token 常量时间比较），自检 264 → 267。



- **`ocg doctor` 对旧版门控误报"判据未通过"**：旧门控的 `/gate/health` 没有 `judgeAgeMs` 字段，
  原实现把 `undefined` 当成失败，指向了错误的排查方向。现在区分"字段缺失（旧版本）"与
  "判据真的没通过"，并把 `egressHost` 缺失显示为"未知（旧版本门控未暴露）"。
- **`ocg doctor` 误报"API key 未设置"**：用 `setx` 之后旧终端不会继承 User 级变量，而计划任务
  在登录时能读到，门控其实工作正常。现在检测到"User 级有值但当前进程没有"时给出
  "新开终端"的提示，不再计为失败项。
- **`ocg health` 对旧版门控显示 `NOT pass`**：同因，现显示 `n/a（旧版本门控）`。
- **`uninstall.ps1` 默认按 8787 找进程**：安装时改过端口（如 8788）的用户，不带 `-Port` 卸载
  可能误杀**另一份安装**的门控。现在未显式指定时，从计划任务参数里解析 `--port`。
- `ocg audit` 的"bin 外部进程"说明补上 `reg`（新增的 User 环境变量探测）。
- **`ocg doctor` 的计划任务状态是假的**：`schtasks` 在中文 Windows 上把字段本地化
  （实测输出 `登录状态/模式`，没有英文 `Status:`），原正则永远匹配不到，于是任何存在的任务
  都被报成 `Ready`。改用 `Get-ScheduledTask` 的枚举值（Ready/Running/Disabled），与系统语言无关；
  实测生产任务正确显示 `Running`（doctor 总耗时约 1.1s，多了一次 PowerShell 调用）。

### 本轮新跑过的验证

| 项目 | 结果 |
|---|---|
| `node bin\ocg.mjs probe --lite`（baseline 重构后首次实跑） | `pass=1 fail=0`，0 token，退出 0 |
| `test-fault.mjs`（此前从未跑） | 18 / 0 |
| `test-bugfix.mjs`（此前从未跑） | 10 / 0 |
| `test-resilience.mjs`（此前从未跑） | 13 / 0 |
| `install.ps1 -NoStart` 路径 | 重复安装不再起第二个监护，PID 不变 |
| `uninstall.ps1` 端口自动识别 | 从任务参数解析出 `--port 8795`（临时任务验证后已删） |
| 非法端口占用的 `start` | 拒绝并打印 PID/进程名，不杀对方 |
| 首提模拟（git init + add -A） | 39 文件，日志/密钥/盘符/USER 占位均 0 |




### 修复（完整审查，2026-10-23 第二轮）

- **`ocg setup dsh --apply` 会清空用户已有 provider（数据丢失级）**：原实现往补丁层追加
  一个新的 `- id: llm-pi-ai` 条目。用 `dsh --dump-config` 实测（改前备份、改后哈希还原）：
  **后一个条目的 `config.providers` 会整体替换前一个**，原有的 `opencode-go` / `ocg-gated`
  全部消失。现改为**文本插入**到既有的 `providers:` 下，写前自检（条目数不变、两个新键各一次），
  结构不符则拒绝并打印片段。
- **`ocg setup dsh` 片段结构与 dsh 实际 schema 不符**：原来输出 `llm: / providers: / type: / apiKey:`，
  而 dsh 读的是补丁层数组条目 `- id: llm-pi-ai` + `config.providers.<id>` + `api:` + `apiKeyEnv:`。
  按旧文档接入根本不会生效。已按真实 schema 重写，并用 `--dump-config` 验证可解析、可合并。
- **重复安装会起第二个监护进程**：端口上已有本门控时，`install.ps1` 仍会注册并启动任务，
  新监护与旧门控抢端口 → 反复重启。新增 `install-service.ps1 -NoStart`，安装器检测到
  "本门控已在跑"时只刷新任务、不启动。
- **`uninstall.ps1` 会停掉别的安装**：原先按 `ocg-supervise.mjs` 命令行动刀，不区分目录；
  现在要求命令行同时包含当前仓库根。
- **非交互式下 `install.ps1` 会卡在 `Read-Host`**：端口被占或缺 key 时，若 stdin 被重定向，
  现在直接报错并给出 `-Port` / `setx` 指示，不阻塞。
- **`ocg doctor` 的客户端检查与实际端口无关**：原先只要配置里有 `ocg-gated` 就报"已指向"，
  8788 的实例会被 8787 的配置误判；现按当前端口精确匹配，并区分"端口不对"。
- **文档漂移**：`OPERATIONS-zh.md` 写探针每 15 分钟，脚本实际 10 分钟，已对齐。

#### 真机安装暴露的两个问题（同日早前）

- **计划任务没有把端口传给门控**：`install.ps1 -Port 8788` 时任务动作仍是裸入口，
  门控退回默认 8787 与被占用的生产实例冲突，`/gate/health` 永远起不来。
  现在任务动作是 `node bin\ocg-supervise.mjs --port 8788`，监护解析 `--port` 后写入 `GATE_PORT`。
- `install.ps1` 体检输出在自检未完成时打印 `selftest=` 空值 → 改为 `pending`。

### 审查中确认无问题的项

- 端口被非门控进程占用：拒绝启动、打印 PID+进程名、不结束对方 ✅
- 端口上已有本门控：提示后退出，不抢端口 ✅
- `stop.flag`：监护进程退出且不再拉起 ✅
- `--apply` 遇到已有 `ocg-gated`：拒绝写入，文件哈希不变 ✅
- `diag --out`：文件生成、脱敏（key/session/路径）✅
- 可观测性套件（20 条）首次运行全过 ✅



### 真机验证（2026-10-23，Windows / Node 24.15.0）

| 场景 | 结果 |
|---|---|
| 同名任务指向别的目录 | 中止并打印对方路径，未改动生产任务 ✅ |
| `install.ps1 -Port 8788 -TaskName 'OCG Test Gate' -NoToken` | 注册任务 → 启动 → `health ok=true` ✅ |
| `doctor`（8788） | 9 项中 8 绿 1 红（红项是测试实例用假上游，预期）✅ |
| 杀掉门控子进程 | 监护 1.5s 拉起（PID 28008 → 29976），health 恢复 ✅ |
| `uninstall.ps1` | 删除任务、停进程、端口释放 ✅ |
| `install.ps1`（启用 token） | 生成 `tok_…` 写入 User 环境变量；无 token 请求 401；`tokenRequired=true` ✅ |
| 生产任务 | 全程未被改动 ✅ |

### 新增

- `bin/ocg-supervise.mjs`：进程监护（计划任务的真实入口；门控退出后 1.5 秒拉起，带退避）。
- `install.ps1` 新增 `-TaskName` / `-Force`；**同名计划任务指向别的目录时中止**，不再静默覆盖
  （旧实现会无条件 `Unregister-ScheduledTask`，跑一次就能把另一份安装的生产任务改道）。
- `docs/PUBLISH.md`：发布前待办（账号相关步骤与转 public 的 7 项闸门）。
- `.gitattributes`：`*.ps1/*.cmd/*.vbs` 固定 CRLF，日志类不参与 diff。
- `docs/AUDIT.md` 补"代理这一跳"：Node 22+ 会自动使用 `HTTP(S)_PROXY`，抓包核验时要知道。
- `bin/ocg.mjs` 子命令：`doctor`（九项体检）/ `audit`（离线审计）/ `diag`（脱敏诊断）/
  `setup dsh`（打印配置片段）/ `start` / `probe` / `check` / `health`。
- 首次运行缺 key 时交互式索取，并写入 User 级环境变量。
- `install.ps1`（支持 `-WhatIf` / `-NoTask` / `-NoToken`）、`uninstall.ps1`、`start.cmd`、
  `scripts/install-service.ps1`、`scripts/regress.ps1`。
- `docs/BASELINE.md`、`docs/AUDIT.md`、`docs/DSH.md`、`examples/overlay-ocg.yml`。

### 移除

- 所有 Docker / compose / systemd 文件（本项目只支持 Windows，不做容器分发）。
- `logs/`、`snapshots/`、`HISTORY.md`、`restart-dsh.ps1`、`watchdog-gate.*`、
  `run-gate-daemon.ps1`。

### 已知未验证

- ~~Task Scheduler 的 `RestartCount/RestartInterval` 是否真能在进程被杀后拉起门控（待实测）。~~
  **2026-10-23 已实测：不会重启。** 场景 A：进程 `exit(1)`，3 分 20 秒内启动次数始终为 2；
  场景 B：外部 kill，85 秒后仍未重启（`LastResult=0xFFFFFFFF`）。
  该设置只覆盖"任务启动失败"，不覆盖"程序跑起来后又挂了"。
  **已改为进程内监护**：`bin/ocg-supervise.mjs`，子进程退出后 1.5 秒重启，
  1 分钟内连续退出超过 5 次则退避 15 秒。计划任务只负责登录时把监护拉起来。
  实测：杀掉门控子进程（PID 29868）后 1.5 秒由监护拉起新进程（PID 30332），`/gate/health` 恢复 `ok=true`。
- Node 22 运行时**已实测**（2026-10-23，v22.23.4）：`node --check` 全过、`verify-patch` 264/264、
  `test-coverage` 48/48。Node 24.15.0 同为 264/48。
  **真实上游套件也已在 Node 22 跑通**（`regress.ps1 -IncludeSoak -NodeExe <node22>`）：
  264 + 48 离线 + 26 + 11 + 16 + 8 + 7 + 18 + 12 真实上游 = 全部 0 失败，含 60 秒 soak。
  另做了带运行时证据的定向复核：门控进程 `ExecutablePath` 确为 `node.exe`（v22.23.4），
  `test-suite` 26/26、`test-real` 18/18 通过。
- `scripts/regress.ps1` 新增 `-NodeExe` 参数（默认 `node`），用于在指定运行时上跑全套回归。