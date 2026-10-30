# opencode-ds-route

[![ci](https://github.com/ikaros333/opencode-ds-route/actions/workflows/ci.yml/badge.svg)](https://github.com/ikaros333/opencode-ds-route/actions/workflows/ci.yml)

> **如果你也是 opencode go 套餐的订阅者，而且还是 deepseek 模型的深度使用者，同时不想让 opencode 给你路由到第三方的、自部署的掺水 deepseek 模型的话，请看看这个项目！它能极大地保证你在使用 opencode go 套餐时能路由到官方的 deepseek。**

`v0.1.3` · Windows only（仅在 Windows 11 验证）· Node ≥ 22 · 0 依赖 · MIT

在 `127.0.0.1:8787` 起一层本地门控：**只有能证明来自官方 DeepSeek 后端的响应才放行，其余一律 503。**
它不改变 OpenCode 的路由，只判断"这次响应是不是官方的"。

**前提**：你需要一个 **OpenCode Go 套餐的 key**（在 opencode.ai 控制台获取）。没有这个 key，本项目对你没有用处。

> 非官方项目，与 OpenCode / DeepSeek 无关联。使用前请读下面的[免责声明](#免责声明)。

## ⚠ 重要：`messages` 协议已默认封禁（2026-10-27）

**本项目现在只支持 `responses` 一个协议。** `messages`（Anthropic 风格）和 `chat` 默认都被拒绝，返回 `503 gate_proto_blocked`。

原因（实测，不是推测）：

| 观测 | 数据 |
|---|---|
| `messages` 响应 id 出现三种生成器 | `UUID4` / 13位毫秒时间戳+40hex / 32hex，**同一小时内轮换**；官方直连恒为 `UUID4` |
| 参数校验时有时无 | `max_tokens=0` 有时 400（正确）有时 **200**（不校验）；`role:"wizard"` 有时 422 有时 **200** |
| 抓到 Go 实现参与 | `500 Upstream request failed: [invalid_request] json: cannot unmarshal string into Go struct field plain.max_tokens` —— DeepSeek 官方是 Rust/serde，不会产出这句 |
| 每次响应都被网关改写 | `usage` 恒含 `cost`+`opencode`，恒缺官方的 `service_tier` |

也就是说：这条通道后面挂着**至少三套实现**在轮询，其中至少一套不做官方参数校验。按本项目"只接受官方后端"的约束，它必须被拒绝——这是判据在正常工作，不是 bug。

**想自己验证**：`GATE_ALLOW_MESSAGES=1` 解封后连打 10 次 `/v1/messages`，台账会同时出现 `PASS` 与 `REJECT_SHAPE_UNKNOWN(idShape=other53)`。

**要恢复 `messages`**：先按 [docs/BASELINE.md](docs/BASELINE.md) 的 B4-drift 重新标定指纹，再设 `GATE_ALLOW_MESSAGES=1`；否则只会得到"时而 200 时而 503"。

**能力边界**：`responses` 通道最高只能到 `trustLevel=medium`（`/gate/health` 可见）。官方直连的强证据（UUID4 直出 id、UUID4 `request_id`、原样字段名、严格枚举、`service_tier`、logprobs 真值）已被 OpenCode 全部替换，本通道**无法**给出"官方后端"的证明——详见 [docs/BASELINE.md](docs/BASELINE.md)。

## 下载与安装

**先决条件**：Windows 10/11、Node ≥ 22、一个 **OpenCode Go 套餐的 key**。

**第 1 步 · 下载**

去 [Releases · v0.1.2](https://github.com/ikaros333/opencode-ds-route/releases/tag/v0.1.3) 下载
`opencode-ds-route-v0.1.3.zip`；或用 `git clone` 拉取仓库。

> **只从本仓库的 Release 下载。** 这个程序会经手你的 key，fork 或第三方转载的包可能被改过。

下载后先校验，一致再解压：

```powershell
Get-FileHash .\opencode-ds-route-v0.1.3.zip -Algorithm SHA256
# 与 Release 附件里的 SHA256SUMS.txt 对照，必须完全一致
```

**第 2 步 · 解压到固定目录**

例如 `D:\tools\opencode-ds-route`。解压后这一层应能看到 `README.md`、`install.ps1`、`bin\`、`gate\`
—— 下文说的「仓库根」就是它，所有命令都在这里执行。

**第 3 步 · 在仓库根打开 PowerShell**

在资源管理器地址栏输入 `powershell` 回车；或按住 Shift 右键 →「在此处打开 PowerShell 窗口」。

**第 4 步 · 解除锁定并运行安装**

```powershell
Unblock-File .\install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

- 报「禁止运行脚本」→ 少了 `-ExecutionPolicy Bypass`；
- 报「未数字签名 / 无法加载文件」→ 没做 `Unblock-File`（浏览器下载的文件会带"来自网络"标记）。

**第 5 步 · 安装脚本会做什么（约 30 秒）**

1. 检查 Node ≥ 22；
2. 向你要一次 key（输入不回显，只写进 User 级环境变量）；
3. 检查 8787 是否被占（不会杀别人的进程，会提示换端口）；
4. 生成 `GATE_TOKEN`，挡住本机其它进程白嫖你的 key 配额；
5. 注册「登录时启动」的计划任务，启动并验证 `/gate/health`。

**第 6 步 · 验证**

新开一个终端（让新写入的环境变量生效），执行：

```powershell
node bin\ocg.mjs doctor
```

九项全 ✅ 即就绪；哪项是 ❌，它后面那行就是该做的事。

> 不想用脚本也可以：`setx OPENCODE_GO_API_KEY "你的key"` → 新开终端 → `npm run supervise`。

## 接到 dsh（逐步）

**先决条件**

- 已安装 dsh，且 web profile 至少启动过一次（会生成 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`）；
- 新终端里 `echo $env:OPENCODE_GO_API_KEY` 有值；
- dsh ≥ `0.2.0-rc.2`（本文在 `0.2.1-rc.2` 验证；0.1.x 没有 `llm-pi-ai` 这一层配置）。

dsh 的 provider 不写在设置界面里，而是补丁层
`%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`。**这个文件顶层是数组**，每项形如 `- id: <插件>`。

**第 1 步 · 确认门控在跑**

```powershell
node bin\ocg.mjs doctor
```

看「端口 8787」一项是否为 ✅；不是就先解决它，别急着改 dsh 配置。

**第 2 步 · 写入 provider（推荐自动）**

```powershell
node bin\ocg.mjs setup dsh --apply
```

它会先把配置备份成 `cordis.patch.yml.bak-<时间戳>`，再定位 `- id: llm-pi-ai` 下的 `providers:` 插入
两条 provider，写前自检条目数与键数。**结构不符会拒绝写入并打印片段**，不会把文件写坏；
文件不存在也会直接报错——先启动一次 dsh 让它生成 profile。

手动路径（自动拒绝时）：`node bin\ocg.mjs setup dsh` 打印片段，粘贴到已有 `- id: llm-pi-ai` 的
`config.providers:` 下，与现有 provider 同缩进。**只贴下面这两个键，不要把 `- id:` 一起贴**：

```yaml
      # 位置：- id: llm-pi-ai → config: → providers: 下面
      ocg-gated:
        displayName: "OpenCode Go · Responses（经门控）"
        apiKeyEnv: OCG_PLACEHOLDER_KEY
        api: openai-responses
        baseURL: http://127.0.0.1:8787/v1
        # 启用 GATE_TOKEN 时才需要下面两行
        # headers:
        #   x-gate-token: "<你的 GATE_TOKEN>"
        models:
          - id: deepseek-flash      # 客户端别名：门控转发时归一为在售车道（当前 deepseek-v4.1-flash）
      # 2026-10-27 起 messages 协议默认封禁（上游 messages 侧混入非 UUID4 id 池），
      # 因此不再推荐配置 ocg-gated-msg；要恢复见 docs/CONFIG.md 的 GATE_ALLOW_MESSAGES。
      # 原有 provider（例如直连的 opencode-go）留在同一个 providers 下，不要删
```

⚠ **不要新加第二个 `- id: llm-pi-ai`**：实测后一个条目的 `providers` 会整体替换前一个，
原有 provider（包括直连的 `opencode-go`）会全部消失。

**第 3 步 · 重启 dsh 引擎**

关掉正在运行的 dsh（关窗口，或任务管理器结束 dsh / 对应 node 进程），再按平时的方式启动。
只刷新页面无效——`cordis.patch.yml` 只在启动时加载。

**第 4 步 · 验证两处**

```powershell
dsh --profile web --dump-config | Select-String ocg-gated
```

输出里能看到 `ocg-gated`（以及你原有的直连 provider）才说明补丁层被解析；然后打开 dsh 的模型选择器，
列表里应出现「OpenCode Go · Responses（经门控）」。

> 2026-10-27 起不再生成 `ocg-gated-msg`（`messages` 协议已默认封禁，见上方重要提示）。

**第 5 步 · 试一条消息**

选中 Responses 那条（当前唯一可用协议，判据为 serde 文案 + id 形态），发一句 "hello"。之后 `node bin\ocg.mjs doctor` 的
「dsh 配置」一项会显示 **已指向 127.0.0.1:8787**。

**回滚**：用 `.bak-<时间戳>` 覆盖回去，或删掉这两个 provider 段，然后重启 dsh 引擎。

**卡住了？**

| 现象 | 先看这里 |
|---|---|
| `--dump-config` 里没有 `ocg-gated` | 贴错层级（贴到 `config:` 之外）、缩进不对，或没重启引擎 |
| 模型选择器里看不到 | 同上；再确认 dsh 版本 ≥ `0.2.0-rc.2` |
| 发消息 401 | 启用了 `GATE_TOKEN` 但 provider 里没配 `headers.x-gate-token` |
| 全部 503 | 看 [docs/FAQ.md](docs/FAQ.md)，急用先退回直连 |

细节与错误对照见 [docs/DSH.md](docs/DSH.md)。

> **为什么用占位 key**：门控只用自己的 `OPENCODE_GO_API_KEY` 打上游，客户端带来的 key 一律被覆盖，
> 所以 dsh 侧填什么都行。填占位值后，真 key 不再经 `127.0.0.1` 传输（同机其它账户即便抢占端口也拿不到）。
> 前提：`setx OCG_PLACEHOLDER_KEY dummy` 之后**重启 dsh** —— dsh 只在启动时读进程环境，
> 不重启会报 `no credential for provider route` 且该 provider 的模型从选择器里消失。
> 不想折腾就把这两行改回 `OPENCODE_GO_API_KEY`（功能不变，只是真 key 会经过回环）。

### 可选加固：让客户端不带真 key（R1）

门控只用自己的 key，客户端带什么都会被覆盖。所以 dsh 侧可以填**占位 key**，真 key 就不再经过
`127.0.0.1`（同机其它账户即便抢占端口也拿不到）：

```powershell
setx OCG_PLACEHOLDER_KEY dummy      # 只需一次
# 让新进程能看到它：注销/重启系统（Windows 给每个进程的是父进程的环境快照）
pwsh -NoProfile -File scripts\enable-placeholder-key.ps1    # 自动改 web+desktop，带备份与守卫
```

脚本会先检查"当前进程能否看到 `OCG_PLACEHOLDER_KEY`"——看不到就拒绝执行，因为 dsh 只在启动时读
自己的环境，此时改配置会报 `no credential` 且该 provider 的模型从选择器里消失（2026-10-26 实测事故）。
回滚：`...enable-placeholder-key.ps1 -Restore`。
## 其他客户端（非 dsh）

| 字段 | 填什么 |
|---|---|
| Base URL | `http://127.0.0.1:8787/v1`（**只支持 `responses`**；`messages` 默认封禁，见上方重要提示） |
| API Key | **填任意占位值即可**（如 `dummy`）：门控用自己的 key、不校验客户端这个值；开了 `GATE_TOKEN` 时另加 `x-gate-token` 头 |
| Model | `deepseek-flash`（**客户端别名**：门控按 `rankCandidates` 归一为在售车道 `deepseek-v4.1-flash`，台账记 `x-gate-model-substituted`） |

成功时长这样（`doctor` 九项全绿）：

```text
✅ Node       v24.15.0
✅ API key    已设置（值不回显）
✅ 端口 8787   门控在跑（selftest=pass）
✅ 计划任务   Running（登录自启）
✅ 判据       最近一次通过：2.4s 前（基线 2026-10-23）
结论：门控正常。
```

## 它做什么 / 不做什么

| 做 | 不做（明写，别指望） |
|---|---|
| 挡住"看起来像官方、实际是第三方池"的响应 | 判断官方模型是否降智 |
| 交付前给出可读的拒绝原因 | 防蓄意的 TLS 中间人（复刻全部可观测特征即可通过） |
| 出问题能定位到具体判据 | 分辨"第三方转售真官方 API" |
| 拦掉"只有思考、没有正文"的响应（`gate_structure_bad`） | 证明响应来自 DeepSeek 官方服务端（上游已抹掉全部官方指纹，见下） |
| 把 `trustLevel`（`strong`/`medium`/`weak`/`blocked`）暴露到 health 与响应头 | 把 `medium` 变成 `strong`（只有上游恢复官方直出形态才可能） |

一句话：**能拒绝「意外的第三方」，不能拒绝「蓄意的中间人」，也不能证明「这就是官方后端」。**

## 怎么工作

```text
客户端 ──POST──▶ 127.0.0.1:8787 ──▶ ① 形态预检：这条通道还是正常网关形态吗？
                                  ② 转发：用你的 key 打 opencode.ai:443（唯一出网目标）
                                  ③ 交付闸：id 位模式 / usage 键集 / 结构完整性
判定通过 ──▶ 交付（附 x-gate-trust）；判不了 ──▶ 503 + 可读原因（/gate/alerts）
```

只有 `responses` 一个协议；`messages` 与 `chat` 默认拒绝（见上方重要提示）。
判据全部是黑盒可观测的结构事实，常量与观测日期见 [docs/BASELINE.md](docs/BASELINE.md)。

## 出问题了

```powershell
node bin\ocg.mjs doctor    # 九项体检，每个 ❌ 后面都跟着下一步
node bin\ocg.mjs diag      # 脱敏诊断，直接贴 issue
```

**一步退回直连**：删掉客户端里指向 `127.0.0.1:8787` 的 provider，改回 `https://opencode.ai/zen/go`。
本项目的价值是"验证"，不该成为你唯一的通路。

## 安全（key 会经过它，所以值得知道）

- **只从这个仓库的 Release 下载**：本项目会经手你的 key，任何人 fork 后改一行 `gate/` 就能把它发去自己的服务器。核对发布页的 `SHA256SUMS.txt`，别用第三方转载的包；
- **0 第三方依赖**，出网只有 `opencode.ai` 一个 host（代码里的常量）；
- key 只从环境变量读，**不写日志、不进快照、不外传**；台账只记状态码与耗时，不记 prompt 正文；
- 默认只绑 `127.0.0.1`，`install.ps1` 会生成 `GATE_TOKEN`，挡住本机其它进程白嫖配额。

不信的话自己验，不用信这段话：

```powershell
node bin\ocg.mjs audit                     # 依赖 / 出网 / key 使用点 / 写盘点
set GATE_TRACE=1; node bin\ocg.mjs start   # 每次出网目标打到屏幕
```

细节见 [docs/AUDIT.md](docs/AUDIT.md)。

## 常见问题（完整版见 [docs/FAQ.md](docs/FAQ.md)）

| 现象 | 先做什么 |
|---|---|
| 客户端 `Connection error` | `doctor`：门控没在跑，或端口不对 |
| 全部 503 | `diag` + [BASELINE.md](docs/BASELINE.md)；急用先退回直连 |
| `messages` 503 `gate_proto_blocked` | **预期行为**：`messages` 已默认封禁，改用 `responses`（见上方重要提示） |
| `x-gate-trust` 只有 `medium` | 预期：本通道上限就是 `medium`（见 [FAQ.md](docs/FAQ.md)） |
| 401 `gate_unauthorized` | 客户端没带 `x-gate-token` 头（或重装用 `-NoToken`） |
| 装了反而慢 | 多客户端共用 session；只给 dsh 用，或换端口另起实例 |
| 端口通但代码改了没生效 | `doctor` 看「门控归属」：可能跑的是另一份安装（同名任务被覆盖过） |
| 起了第二次但没日志、也没报错 | 单实例锁生效：第二个监护 exit 3，占用者写在提示里；查 `supervise-<port>.lock` |

## 自启 / 停止 / 卸载

- 自启：`install.ps1` 注册计划任务，入口是监护进程 `bin\ocg-supervise.mjs`（门控退出 1.5 秒拉起）；
- 临时停用：仓库根建一个空文件 `stop.flag`（监护不再拉起；重启后依然有效）；
- 卸载：`powershell -ExecutionPolicy Bypass -File .\uninstall.ps1`（停监护、删任务、停进程，环境变量与日志保留并告知位置）；
- 同名任务指向别的目录时，安装脚本会中止并要求 `-Force`，不会静默覆盖；
- **同一端口只允许一个监护**：锁文件 `supervise-<port>.lock`（已在 `.gitignore`）。第二个实例会直接退出（exit 3）并打印占用者的 pid/root，而不是变成"抢不到端口的隐形重启循环"。不同端口（如 8787 生产 + 8888 影子）可并存；
- **端口被占用时门控不重试**：探测占用者的 `/gate/health` 拿到归属后以 exit 4 退出，监护见到这个码也不再拉起；
- 归属可查：`/gate/health` 现在带 `root` 与 `pid`，`node bin\ocg.mjs doctor` 会指出"8787 上跑的是另一份安装"。

## 已验证环境

Windows 11 24H2，Node `22.23.4` 与 `24.15.0`：离线 312 + 66 条断言全绿，真实上游 9 套（含 60s soak）全绿。
最后一次验证：**2026-10-26**（单实例锁 / 端口占用归属 / health `root`，本机生产实测通过）。
Linux / macOS 未验证，也不提供安装脚本。

## 免责声明

- 本工具**不改变 OpenCode 的路由**，只在本地筛选响应；但"按上游身份筛选"的用法**可能触及 OpenCode Go 的服务条款**，
  是否允许需你自行核实，后果由使用者承担；
- 若你的用法实际绕开或规避了 OpenCode 与合作方/第三方池的安排，相关商业与合同风险同样由使用者承担；
- 软件按"现状"提供，不提供任何担保；因使用造成的配额、服务或数据损失，作者不承担责任；
- 仅限**单机、自用、单 key**：不用于转售、共享 key、对外代理、规避计费或攻击第三方。

**不接受以上任何一条，请不要使用本项目。** 完整版（含英文摘要）见 [docs/DISCLAIMER.md](docs/DISCLAIMER.md)。

## 文档

- 配置与排障：[docs/CONFIG.md](docs/CONFIG.md)（环境变量全表、端点、按 error.type 处置）
- 判据基线：[docs/BASELINE.md](docs/BASELINE.md) ｜ 安全审计：[docs/AUDIT.md](docs/AUDIT.md)
- dsh 接入：[docs/DSH.md](docs/DSH.md) ｜ 变更记录：[docs/CHANGELOG.md](docs/CHANGELOG.md)
- 提问前：[docs/FAQ.md](docs/FAQ.md) ｜ 报安全问题：[SECURITY.md](SECURITY.md) ｜ 参与开发：[CONTRIBUTING.md](CONTRIBUTING.md)
- 配置样例：[examples/overlay-ocg.yml](examples/overlay-ocg.yml)

## 许可

MIT，详见 [LICENSE](LICENSE)。