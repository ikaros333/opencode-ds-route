## v0.1.4 — 2026-10-30

### 安全加固（发布卫生 + 本机攻击面）

起因：对已发布仓库做了一次自查（密钥/历史/攻击面）。结论：**无密钥泄漏、无远程可利用面**，
但有三项值得收紧，本版处理其中可代码化的两项。

**1. `/gate/*` 观测端点可选鉴权（`GATE_OBS_TOKEN`）**
`health|metrics|proof|matrix|latency|alerts` 会暴露用量、车道、判据状态与本机安装根。
此前只靠「绑回环 + Host 校验」——能挡浏览器 DNS rebinding，**挡不住同用户的本机进程**。
设 `GATE_OBS_TOKEN` 后必须带 `x-gate-token`；与 `/v1/*` 的 `GATE_TOKEN` 解耦；默认关闭以保持脚本兼容。
`ocg health/metrics/...` 自动携带该头。

**2. README 明确「本项目不在 npm 发布」**
`package.json` 是 `private: true`（不会被误发），但 `opencode-ds-route` 这个**名字**若被第三方
在 npm 抢注，任何 `npm i` 都会装到别人的包。README 顶部加声明。

**3. SECURITY.md 补充「不要运行别人分支里的脚本」**
`install.ps1` / `scripts\*.ps1` 会写 User 级环境变量、注册计划任务；对 PR 分支直接
`-ExecutionPolicy Bypass -File` 等于以你的身份执行任意代码。同时记录仓库侧保护状态。

### 仓库侧保护（非代码，已启用）

- `main`：禁强推、禁删除、对管理员同样生效；
- 标签 `v*`：ruleset `protect-release-tags` 禁止删除与改指向（发布产物不可被静默替换）。

### 复核后纠正的一条结论

此前怀疑 `ocg` 里 `TASK_NAME` 拼接 PowerShell 存在命令注入 —— **不成立**：
`TASK_NAME` 是常量，`install-service.ps1` 通过 **参数绑定** 传给 `Register-ScheduledTask`，
`-Argument` 用 `-f` 格式化且 `$Port` 是 `[int]`。无拼接注入面。

### 未做（明确记录，不假装已完成）

- **Release 产物仍无签名**：sha256 与 zip 同渠道，仓库被入侵时可同时替换。需 GPG/cosign 治本；
- **key/token 仍明文存于 `HKCU\Environment`**：同用户进程可读，需改 DPAPI/ACL 文件。

### 测试

```
verify-patch  332 / 0   （+7 条 AA 段断言）
test-coverage  84 / 0   （+6 条 G16 用例）
```
## v0.1.3 — 2026-10-29

### 新增：每响应指纹（交付侧 8 项必要条件）

**动机**：交付闸此前只查 `id` 形态一项，第三方/自部署实现只要能造出 `resp_`+UUID4 位模式就能过。
按「提高拒答率 + 提高落到基线实现的概率」两个目标，把交付闸升级为逐响应指纹：

1. 非流式 `responses`：必需字段全在且无未知字段、`usage` 七键、`total=input+output`、
   item id 形如 `rs_/msg_/fc_`+32hex、`incomplete` 必有 `reason`、`content` 键 ⊆ 白名单、
   请求带 `reasoning` 时响应必须回显；
2. 流式：事件家族齐全 + 终止事件 ∈ `{completed, incomplete}` + `sequence_number` 单调
   （旁路采样，**不缓冲、不改字节、不增加首 token 时延**）；
3. 不匹配默认 `retry`：丢弃该响应并重发（最多 2 次），把「单次抽池」变成「3 次抽池」。

**预检窗口 90s → 15s**：实测池切换是分钟级，90s 会让预检结论与交付时刻错位。

**实测基线**：flash 车道 10/10 全绿（18 字段 / usage 七键 / 算术恒等 / item id / 事件家族），
真实上游 10 次非流式 + 5 次流式全部 `fpMismatch=0`、`fpRetries=0`。

**踩到的三个坑（已修，留档）**：
- SSE 的 `data:` 行会被 TCP 分片切开 → 跨片行解析失败，误报 38 次 `FP_MISMATCH`（改为有界 carry）；
- 流的第一段已被 `peekBody` 读走并缓存在 `r.buffered`，不喂给采样器就会永远缺 `response.created`；
- 挂了 Transform 后不能再监听 source 的 `end` 去 `res.end()`，否则截断末尾事件（5 次丢 4 次）。

**判据强度不变**：仍是 `medium`。指纹提高的是「拒答率」与「命中基线实现的概率」，**不是**「证明官方」。
## v0.1.2 — 2026-10-27

### 上游单方面变更：`deepseek-flash` 下线 + 判据整体漂移（门控全量 503 的根因）

**现象**：16:01 起所有请求 503 `gate_no_official_route`，预检 detail 为
`msgfp:net(fingerprint=410,410,…,410 有效0/9)`；e1 侧同时失效。

**根因（实测）**：`opencode.ai/zen/go` 下架 `deepseek-flash`，任何带该模型的请求返回

```json
410 {"type":"error","error":{"type":"ModelDeprecated",
     "message":"Model deepseek-flash has been deprecated. Use deepseek-v4.1-flash instead."}}
```

而门控所有探针固定使用 `ALLOWED[0]`（当时的 `deepseek-flash`），9 项指纹变成 `410×9`，
与基线 `400×6,422×3` 不符 → `verdict:unknown` → fail-closed。

**这不是 bug**：fail-closed 正确地拦住了「拿不到官方证据」的流量；问题在默认车道与判据都过期了。

### 改动

1. **默认车道** `GATE_CHAIN`：`deepseek-flash,deepseek-v4.1-flash` → **`deepseek-v4.1-flash`**。
   车道的语义是「同一后端的优先级偏好」，不是选模型；官方已明确 `deepseek-flash` 永久退役。
2. **`responses` 主判据换成 serde 文案**（`baseline.mjs` 新增 `E_SERDE_MSG` / `E_SERDE_EXTRAS`）：
   - 旧 e1（缺 `input`）现在被网关自行拦掉，返回 `503 Endpoint is unavailable`，**不再穿透**；
   - 新 e1s：`reasoning.effort="bogus"` → 官方 Rust serde 层原话
     `Failed to deserialize the JSON body into the target type: reasoning_effort: unknown variant ...`
     + `(request_id: <uuid4>)`；
   - 除主体文案外还要求伴生特征（`unknown variant` + 枚举里的 `xhigh`），防止只回了半句话的转发层；
   - 实测 2026-10-27：**5/5 = 422 + 该文案 + UUID4 request_id**。
3. **`messages` 协议无条件封禁**（除显式 `GATE_ALLOW_MESSAGES=1`）。理由（实测）：
   - 9 项指纹整体漂移：`max_tokens=0` 由 400→**200**、缺 `messages` 由 422→**500**、
     非法 `role` 由 400→**200**（说明该侧至少混入了一个不做官方参数校验的实现）；
   - 正常响应的 id 有 **5/8** 落到 53 位 hex 池（非 UUID4）→ 命中交付闸「形态未知」分支，
     表现为「同一会话时而 200 时而 503」，既不可用也不可信；
   - 不用 `GATE_BLOCK_PROTOS` 兜底：那是「追加」语义的旧开关，机器上普遍留的是
     `GATE_BLOCK_PROTOS=chat`，靠代码默认值兜底会让沿用旧 env 的部署静默解封 messages。
4. **独立探针 `probe/official-detect.mjs`** 同步换模型与判据（`--lite` 仍是 0 token）。

### 验证

- `verify-patch` 293 → **300**（新增 X1–X7：默认车道、旧链不得回归、messages 无条件封禁、
  serde 判据与伴生特征、baseline 单源）；
- `test-coverage` 53 → **57**：G8 拆成「默认封禁 messages（503 `gate_proto_blocked`）」+
  「显式解封后三协议并行」；G1 因默认链只剩 1 条车道改写实——
  `upstreamDown()` 的阈值是 `min(FAIL_LANES, 车道数)`，单车道下 1 次连接失败即收敛，
  慢挂换道分支只在多车道时才会命中（断言改为「一次失败即收敛 + 无同车道重试」）；
- `node probe/official-detect.mjs --lite` 对真实上游跑通。

### 已知取舍

- `messages` 解封后的指纹基线（`MSG_FINGERPRINT_2026_10_27`）只作留档、**未启用**；
  重新标定前解封会永久 `unknown` → 全量 503（安全方向）。
- dsh 侧的模型别名仍是 `deepseek-flash`（门控转发时按 `rankCandidates` 归一为 `deepseek-v4.1-flash`，
  台账会记 `x-gate-model-substituted`），因此无需改动任何 dsh profile 的 model 字段。

### 判据冻结（同日 18:0x，最终形态）

**为什么冻结**：这一晚判据被上游打断了两次（e1 不再穿透 → e1s 枚举校验被取消 → e2s 类型校验开始抖），
每次重标定都是一次全量 503 风险。实测数据说明根因不是"判据选错"，而是**上游至少两个实现在轮询**：

```
同一探针 max_output_tokens:"abc"：09:20 → 422，09:2x → 200（门控探针同时刻仍是 422）
messages 侧：同一小时内 id 出现 UUID4 / 13位时间戳+40hex / 32hex 三种形态，
             并抓到 Go 实现报错 `json: cannot unmarshal … Go struct field plain.max_tokens`
```

**冻结后的判据（只依赖实测 100% 稳定的特征）**：

| 判据 | 实测稳定性 | 用途 |
|---|---|---|
| 成功响应 id = `resp_uuid4` 位模式 | 38/38 | **放行条件**（形态探针 + 交付闸） |
| `usage` 含 7 个必需键 | 20/20 | **放行条件** |
| 响应含非空 `message`（或工具调用） | 20/20（空正文只在 max_output_tokens 过小时出现） | **交付结构闸** |
| 5 参数探针的返回码向量 | 不稳定（422↔200） | **降级为观测**：`IMPL_VECTOR_DRIFT` / `IMPL_GO_STACK` 告警，不参与放行 |

**代码改动**：
- `PROTO_TRUST.responses: 'eclass' → 'shape'`，新增 `runShapeProbe()`（1 token，id 位模式 + usage 键集）；
- `deliver()` 新增结构闸：非流式 `responses` 无正文且无工具调用 → `503 gate_structure_bad`；
  被 `max_output_tokens` 截断但有正文 → 交付并打 `x-gate-truncated: 1`；
- 新增 `trustLevel()`（`strong/medium/weak/blocked`）与 `health.trustLevel`、响应头 `x-gate-trust`；
- 新增 `runImplVector()`（默认 5 分钟）只告警不放行；`GATE_IMPL_VECTOR_MS=0` 可关；
- `baseline.mjs` 增 `USAGE_KEYS_REQUIRED`、`IMPL_VECTOR_2026_10_27`。

**能力边界（写清楚，不再含糊）**：本通道最高只能到 `medium`——能证明"是同一个 DeepSeek 模型 + 网关形态正常 + 结构合法"，
**不能**证明"由 DeepSeek 官方服务生成"，因为 OpenCode 已把 UUID4 直出 id / UUID4 request_id / 原样字段名 /
严格枚举校验 / logprobs 真值全部替换掉。需要 `strong` 只能直连 `api.deepseek.com`（由使用者自行决定，不在本项目的默认路径内）。

**验证**：`verify-patch` 300 → **312**（新增 Y1–Y10）；`test-coverage` 57 → **66**（新增 G13 结构闸/截断标记）；
真实上游端到端连打 20 次 0 失败。

### 安全与发布卫生（上传前审查）

- **`doctor` 不再打印 key 长度**（`bin/ocg.mjs`）：doctor 输出常被贴进 issue/聊天，长度是账号维度的稳定特征，属不必要的弱泄露；现在只显示「已设置（值不回显）」。
- **清除真实上游 `request_id`**：`gate/baseline.mjs` 注释与 `gate/test-coverage.mjs` 夹具里曾出现一次真实观测到的 `gw-…` 网关 id，改为占位形态。
- **`.env.example` 修正**：`GATE_CHAIN` 改为在售的 `deepseek-v4.1-flash`（旧值 `deepseek-flash` 现在返回 410，照抄会让门控全量 503）；`GATE_PRECHECK_TTL_MS` 示例对齐代码默认 `90000`；补 `messages` 默认封禁与 `GATE_ALLOW_MESSAGES` 的说明。
- **文档明确 `messages` 已不可用**：README 顶部新增「⚠ 重要：`messages` 协议已默认封禁」小节（含实测数据表与恢复步骤），`docs/FAQ.md` 新增两问（封禁原因与处理、`medium` 为何升不到 `strong`），`docs/DSH.md` 判据表同步更新。
- **审查结论（工作区 + 全 git 历史）**：无密钥/令牌/私钥、无个人绝对路径、无运行时产物、无二进制与大文件；CI 为 `contents: read` 且不使用仓库 secret；监听固定 `127.0.0.1` + 非回环 Host 拒绝 + 可选 `GATE_TOKEN`。

## v0.1.1 — 2026-10-26（已发布）

### 修复：大包请求「一次挂死 = 整条报废」（总预算 60s → 120s + 慢挂不再重试同车道）

- **网络/判据**：判据与交付逻辑零改动，只改超时/重试的时序。
- **标定依据（本机台账实测）**：大包流式请求（≈2.6MB / 39 tools）首字节
  p50 3.9s、p90 36.4s、p99 **54.3s**；故单次尝试上限保持 60s（压到 30s 会砍掉 p90–p99 的合法成功）。
  但 `TOTAL_BUDGET_MS` 原为 60000，与单次上限相等：一次挂死即耗尽预算，第 2 条车道拿不到时间
  （台账 8480b685 / 7d51cad2 / e1b768a4 的 attempts 都只有 1 条）。
- **改动 1**：`GATE_TOTAL_BUDGET_MS` 默认 60000 → **120000**（= 车道数 2 × 单次上限 60s）。
- **改动 2**：吃满单次上限的「慢挂」**不再同车道重试**，直接换道（台账记 `LANE_SLOW_HANG`）。
  否则即使预算翻倍，也只会变成同一条车道连挂两次，第 2 条车道照样轮不到；
  `LANE_RETRY` 只保留给毫秒级连接错误（ECONNRESET 等）。
- **测试解耦**：`scripts/regress.ps1` 给影子门控显式钉住 `GATE_TOTAL_BUDGET_MS=60000`，
  与其断言（`<70s`、`max<60000`）保持一致，不再依赖生产默认值。
- **验证**：`verify-patch` 292 → 293（新增「慢挂不重试同车道」断言，预算默认值断言同步更新）；
  `test-coverage` 仍 53 条：G1 由「预算耗尽」改为「两车道全挂 → fail-closed 且 `laneSlowHang=1`」
  （慢挂改造后，全挂场景的正确归类是 `gate_upstream_unreachable`，`budget_exhausted` 的映射仍由
  `verify-patch` 静态断言覆盖）；影子门控 + 假上游实测两条路径：① lane1 挂住 → 换道 lane2 交付 200；
  ② 两条车道都挂 → 503 且 attempts 恰为 2（没有同车道重复）。
- **可观测**：`/gate/metrics` 新增 `laneSlowHang`。

### 安全：客户端不再需要真 key（消除"端口被抢 → key 被收走"）

- **网络/判据**：门控行为不变（它一直用自己的 `OPENCODE_GO_API_KEY`，客户端带来的 key 会被
  `headersFor()` 无条件覆盖）。改动在**客户端侧**：dsh provider 的 `apiKeyEnv` 改用占位变量
  `OCG_PLACEHOLDER_KEY`（值 `dummy`），于是真 key 不再经 `127.0.0.1` 传输。
  风险背景：同机另一个 Windows 账户可以先抢占 8787 收下 dsh 发来的明文 key，`GATE_TOKEN` 挡不住。
- **可观测**：门控在发现客户端仍送**真 key** 时记一次 `CLIENT_SENT_REAL_KEY`（含修复提示），
  `/gate/health` 暴露 `clientKeyFromEnv`；`ocg doctor` 增加「客户端 key」检查（配置仍在用真 key 时告警）。
- **env**：`ocg setup dsh` 会确保 `OCG_PLACEHOLDER_KEY=dummy` 存在；`install.ps1` 同样写入。
- **文档**：README / `docs/DSH.md` 的 provider 示例改为占位 key，并写明**必须重启 dsh**。
- **事故与教训（2026-10-26）**：先只改配置、没有重启 dsh → dsh 报
  `llm-pi-ai: no credential for provider route "ocg-gated-msg"`，且该 provider 的模型从选择器消失。
  根因：**dsh 只在自己的进程启动时读环境变量**，不读实时系统变量；变量写入时间（13:24）晚于
  dsh 启动时间（11:28）。已立即回滚配置，并在 `ocg setup dsh` 输出、`install.ps1`、README、
  `ocg doctor` 四处加上"设完变量必须重启 dsh，否则会 no credential / 模型消失"的显式警告。
- **工具**：新增 `scripts/enable-placeholder-key.ps1`（带环境变量守卫、逐文件备份、`-WhatIf`、`-Restore`），
  只有在「当前进程能看到 `OCG_PLACEHOLDER_KEY`」时才允许改配置 —— 这条守卫直接编码了上面的事故条件。
  现场实测：dsh 由 WMI 拉起的 `cmd.exe` 启动，其环境快照来自 08:18（早于 13:24 的变量写入），
  所以「重启 dsh」并不等于「重启环境」；必须注销/重启系统，或从新父进程重新拉起。
- **测试**：`verify-patch` 增加 W11–W13，自检 289 → 292。影子门控 + 假上游实测：客户端送 `dummy`
  时上游收到的是门控自己的 key；客户端送真 key 时台账只记一条 `CLIENT_SENT_REAL_KEY`、
  `health.clientKeyFromEnv=true`。

### 仓库卫生：`.gitignore` 补齐 + CI 新增脚本编码断言

- **文件**：`.gitignore` 补 4 条 —— `matrix.json`（`GATE_SNAPSHOT` 指到仓库根时的兜底）、`.envrc`（direnv 里
  常写 `export OPENCODE_GO_API_KEY=...`，漏忽略等于漏 key）、`*.rar`、`.history/`（编辑器本地历史）。
  仍**故意不**忽略 `*.lock` 通配：那会连 `yarn.lock` / `pkg` 类锁文件一起吞掉，所以只写 `supervise-*.lock`。
- **CI**：`windows` job 新增「脚本编码检查」：`.ps1`/`.vbs` 含非 ASCII 必须有 UTF-8 BOM、三类脚本行尾必须
  CRLF（`.cmd` 例外：BOM 会让 cmd.exe 把首行当命令）。这条正是本轮 BOM 事故的守门人 —— `.gitignore`
  管不到编码，只有断言能拦。
- **文档**：CI 步骤名里过期的「273 条断言」改为 289。

### 加固：重复部署可识别、不隐形重启（单实例锁 / 端口占用归属 / health `root`）

- **文件**：新增运行时锁 `supervise-<port>.lock`（已进 `.gitignore`），同端口只允许一个
  `bin/ocg-supervise.mjs`；第二个实例 exit 3 并打印占用者 pid/root。**锁的真值来源是端口应答**：
  锁里的 pid 活着但 `/gate/health` 无应答时按陈旧锁回收（Windows 会快速复用 PID，只看 pidAlive
  会让该端口永久起不来）；目录只读导致锁不可用时降级为"不加锁继续"，不阻断启动。`uninstall.ps1`
  卸载时清理锁文件。
- **网络/判据**：无变化。端口被占用时门控**不再退避重启**：探测占用者的 `/gate/health` 拿到
  `pid`/`root`/`deliverableShapes`，打印后 exit 4；监护见到 4 直接带走自己。同时写一条台账
  `result: "PORT_IN_USE"`（含占用者描述）—— stderr 在计划任务下进 conhost，台账是唯一持久证据。
  背景：同端口被拉起两次时，第二个门控必然 EADDRINUSE 秒退，旧监护按 1.5s/15s 无限重启，
  而 stderr 进的是 conhost —— 从外部完全看不出"有个空转循环"，表现为"有个门控在跑但重启了个寂寞"。
- **观测**：`/gate/health` 新增 `root`（安装根绝对路径）与 `pid`；`ocg doctor` 增加「门控归属」一行，
  路径归一（大小写/尾斜杠）后比较，指向另一份安装时明确告警（此前只能看到"端口上有门控在跑"，
  会误判为"改了没生效"）。`install.ps1` 与 `uninstall.ps1` 同样改用 `root` 判归属：
  安装时发现端口属于另一份安装会提示并改端口，卸载时不再误杀别人的门控。
- **测试**：`verify-patch` 增加 W1–W10，自检 279 → 289。本机实测：同端口第二实例 → exit 3；
  非门控占用端口 → exit 4（0.2s，无重启，台账留 `PORT_IN_USE`）；门控占用端口 → 打印归属后 exit 4；
  强杀后陈旧锁回收；**伪造"pid 活着但端口无门控"的 PID 复用场景 → 正确回收并启动**；
  `stop.flag` 存在 → 监护 exit 0 且不留锁；非回环 Host 读 `/gate/health` 仍 421（`root` 不外泄）；
  生产重启后 `health.root` 正确、`selftest=pass`、真实 messages 请求 `200 official`。
- **构建卫生**：本轮编辑一度把 `install.ps1` / `uninstall.ps1` 的 UTF-8 BOM 去掉（PowerShell 5.1 会按
  GBK 解析含中文的脚本而失败）。已回写 BOM + CRLF，并用 **PowerShell 5.1 真实解析器**验证两个脚本
  解析通过、`install.ps1 -WhatIf` 可运行。

### 安全修复：resp_ 后缀必须符合 UUID4 位模式

- **网络/判据**：`resp_` 不再一律视为中性。网关改写的 id 后缀必须是「UUID4 去横线」的位模式
  （第 13 位 = `4`，第 17 位 ∈ `89ab`），否则判 `resp_bad` → 第三方 → 拒绝。
  背景：`resp_` + 任意 32 hex 的伪造响应曾被当作中性形态放行（安全洞）。
- **env**：新增 `GATE_RESP_SHAPE_STRICT`。只有显式 `0` 才回退旧行为；未设置 / 空串 / `1` / 拼错
  一律按严格模式处理（配置错误 fail-closed），非 0/1 取值记 `CONFIG_WARNING`。
- **判据**：`DELIVERABLE_SHAPES` 由 `UUID4`/`resp_` 改为 `UUID4`/`resp_uuid4`/`resp_`（`resp_` 仅回退模式）。
- **测试**：`test-bugfix` 增加 3 条回归（合法 `resp_uuid4` 交付、伪造 `resp_bad` 拒绝、畸形 `resp_` 拒绝）；
  `verify-patch` 增加 Q74–Q79，自检 273 → 279。
# CHANGELOG

变更标注三类影响面：**网络**（出网行为/判据）、**文件**（读写路径）、**env**（环境变量）。
触碰网络或 env 的版本会在 Release 说明里单独置顶。

## 0.1.0 — 2026-10-24

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
- **文件**：`verify-patch` 从 240 条断言增至 273 条（下文各轮增量累计）。
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
- 运维手册（现仅维护者本地保留，不随仓库发布）顶部加 13 节目录（锚点已自检对应）。
- README 增加[免责声明](../README.md#免责声明)：明确与 OpenCode / DeepSeek 无关联；说明本工具不改路由、
  只在本地筛选响应，但"按上游身份筛选"的用法可能触及服务条款并影响第三方利益；声明不提供担保，
  并把使用边界限定为单机、自用、单 key。

### 安全审查（2026-10-23，第二轮）

| 项 | 结论 |
|---|---|
| **发现并修复**：`.env` 从当前工作目录加载 | 在别人放好 `.env` 的目录里运行 `ocg`，`GATE_HOST` 可被改写到攻击者主机，prompt 随之外发。现在只读仓库根 `.env`。 |
| **发现并修复**：跨域 no-cors 借道（CSRF） | 页面可以用 `text/plain` 往 127.0.0.1 发 JSON，门控照单全收 → 没开 `GATE_TOKEN` 时可被借额度。现在非 `application/json` 一律 415。 |
| **发现并修复**：DNS rebinding | `evil.com` 解析到 127.0.0.1 时 Host 仍是 evil.com，门控原样受理。现在只认 `127.0.0.1` / `localhost` / `[::1]` 的 Host，否则 421。**第三轮补**：当时校验位置在 `/gate/*` 出口之后，观测端点仍可被 rebind 读取，已上移。 |
| 发布身份泄漏 | 本机 `git config --global user.email` 是真实个人邮箱，首次提交会写进每个 commit。首提交前必须把仓库级身份改成 GitHub noreply 地址。 |
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
| **发现并修复**：`git init` 默认分支是 `master` | 本机 `init.defaultBranch=master`，原发布清单里的 `push -u origin main` 会直接失败。改为 `git init -b main` + 分支校验。 |
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
- **文档漂移**：运维手册写探针每 15 分钟，脚本实际 10 分钟，已对齐。

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