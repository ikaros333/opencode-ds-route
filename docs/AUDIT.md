# AUDIT — 一分钟自己核实

这个文件的目的：让你**不必相信作者**，也能确认这个门控没有把你的 key 送去别处。

全部命令都是只读的、离线的、不需要 key。

## 实测基线（2026-10-23，可用下面命令复现）

| 项 | 数值 | 复现命令 |
|---|---|---|
| 第三方依赖 | 0（只用 `node:http/https/fs/path/crypto`） | `grep -rno "from '[^']*'" gate/ probe/ bin/ \| grep -v "node:\|\\./"` |
| 门控出网点 | 5 个调用，host 恒为单一常量 | `grep -c "const req = transport.request(" gate/oc-gate.mjs` |
| 探针出网点 | 1 个 `fetch`，目标 `opencode.ai/zen/go` | `grep -n "await fetch(BASE" probe/official-detect.mjs` |
| key 使用点 | gate 7 处 / probe 3 处 | `grep -n "\bKEY\b" gate/oc-gate.mjs` |
| 写盘 | 7 处，全在 `gate/logs/` | `grep -n "writeFileSync\|appendFileSync\|renameSync\|mkdirSync" gate/oc-gate.mjs` |
| 外部进程 | gate / probe 0 处 | `grep -rn "child_process" gate/ probe/` |
| 台账内容 | verdict / proto / 指纹 / 耗时 / 端口 / pid，**无 prompt 正文** | `Get-Content gate/logs/gate.jsonl -TotalCount 3` |
| 测试是否联网 | 否（自带 mock 上游） | `npm test`（可断网跑） |

一条命令看全部：`node bin\ocg.mjs audit`

## key 到底经过哪里

```
客户端 ──► 127.0.0.1:8787（本机）
              │  KEY 只在这里被读一次：process.env.OPENCODE_GO_API_KEY
              │  用途只有两处：authorization: Bearer、x-api-key
              ▼
        opencode.ai:443（唯一出网目标，host 是代码里的常量）
```

- 不写文件、不进日志、不进快照、不进 `diag` 输出；
- 不通过命令行参数传递（避免被 `Get-CimInstance Win32_Process` 之类的工具读到）；
- 没有任何遥测/上报代码（`grep -rn "http" gate/` 只有上游调用）。

## 验毒流程（建议第一次照做）

**第 1 步：假 key，看它会不会乱连**

```powershell
$env:OPENCODE_GO_API_KEY = 'fake-key-should-401'
$env:GATE_TRACE = '1'
node bin\ocg.mjs start
```

屏幕上只应出现 `[trace] opencode.ai:443/zen/go/...` 这类行。
`doctor` 会报"判据未通过"——这是**预期**的（假 key 拿不到 200），重点看它有没有连别的域名。

**第 2 步：真 key，开 trace**

新开一个终端，设真 key，再来一次。除了 `opencode.ai:443` 不该有第二个 host。

**第 3 步（可选，最硬）：中间人自证**

用 Fiddler / mitmproxy 观察本机进程出网。`HOST` 是单一常量，多一个域名都藏不住。

> **注意这一跳**：Node 22+ 在环境里存在 `HTTP_PROXY` / `HTTPS_PROXY` 时会自动走代理
> （启动时会打 `[UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental`）。
> 也就是说抓包时你可能只看到"到代理"的连接，而不是直连 `opencode.ai`。
> 判定方法：`echo $env:HTTP_PROXY` 有值就说明这一跳存在，改看代理侧日志即可。
> 门控本身不读代理变量，这一行为来自 Node 运行时。

**第 4 步：确认无误再让客户端接入**

## 安装脚本会改什么

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -WhatIf
```

只会做三件事：

1. 写 **User 级**环境变量（`OPENCODE_GO_API_KEY`，以及可选的 `GATE_TOKEN`）；
2. 注册一个计划任务（登录时启动，失败 1 分钟后重试），可用 `-NoTask` 跳过；
3. 启动并验证 `/gate/health`。

不做：装 Node、改 PATH、写注册表其它位置、安装 Windows 服务、下载外部文件、结束你机器上别的进程。

卸载对称：`uninstall.ps1` 停任务、删任务、停进程；环境变量与日志保留并告知位置。

## 仍然存在的风险（不美化）

| 风险 | 为什么消除不了 | 缓解 |
|---|---|---|
| 作者有推送权 | 供应链风险的本质 | 版本固定 + 发布附 SHA256 + 本文件 + 零依赖 |
| Node 运行时本身 | 不在本项目审计范围 | 用官方安装包，别用第三方魔改 |
| 锁屏前本机其它进程 | 回环绑定对同机进程不设防 | 启用 `GATE_TOKEN`（`install.ps1` 默认生成） |
| 计划任务以你的账户运行 | 需要读 User 级 key | 权限是普通用户，不请求管理员 |
| 上游判据会变 | 黑盒观察的固有属性 | `BASELINE.md` 记录日期与失效点 |
