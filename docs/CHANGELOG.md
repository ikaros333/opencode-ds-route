### 硬约束固化（2026-11-05，用户重申）

两条方向性约束不再只靠口头/记忆，已写进代码与测试：

| 约束 | 机器化位置 | 行为 |
|---|---|---|
| 不用 `deepseek-v4-pro` | `FORBIDDEN` 集合（`oc-gate.mjs`） | 配进 `GATE_CHAIN` 会被剔除；若整条链因此为空 → **启动即拒绝**（不静默 503） |
| 不用 `api.deepseek.com` 作业务上游 | `GATE_ALLOW_OFFICIAL_HOST`（默认 `false`） | `GATE_HOST` 指向 `*.deepseek.com` → **启动即拒绝**，需显式设 `1` 才放开 |

> **不影响的边界**：证据探针（canary 基线 / EV1–EV15）仍会用 `DEEPSEEK_API_KEY` 打官方 API 做**对照**。
> 那是"测"，不是"路由"。若连基线也不用，canary 会标 `no_baseline_key`，按现有语义**拒绝放行**
> （`canary_unproven_no_baseline_key`），不是静默通过。

**因此阶段三的 `GATE_UPSTREAMS` 失去目标**：opencode 侧只有 `deepseek-v4.1-flash` 与 `deepseek-v4-pro`
两条 DS 车道，后者被禁；跨 host 也被禁 → 当前订阅下**没有第二条可切的 DS 上游**。
"判负即切换"的能力保留（多车道配置即生效，G32 覆盖），但在现有约束下它只会退化为"判负即 503"。
后续改进应转向「判定质量与可用性」，而不是「换上游」。

## 未发布（计划 v0.1.9）— 2026-11-05 第二次完整审查

### 修掉的真 bug：车道级预检的 fail 缓存永久锁死

**现象（实测复现）**：双车道 mock，`lane-a` 的探针先坏后好 →
第 1 次请求 `503`，**6 s、13 s、20 s 之后仍然 503**（探针数从 9 涨到 14，说明探针在跑却没生效）。

**根因**：车道级预检的缓存键是 `proto@lane`，而保活 tick 只刷 `proto`（无 lane）。
`precheck()` 的缓存语义是「正向 fail 优先、且不重探」，于是那个车道的 fail 结论**永远无法被覆盖** →
该车道永久不可用，即使上游早已恢复。单车道不触发（handle 与保活同 key），所以只有配多车道时才会中。

**修法**：多车道时保活对每条车道各做一次 `force` 探针（`precheck(p, {force:true, lane:m})`），
单车道（`ALLOWED.length <= 1`）不发额外探针、探针数与旧版完全一致。

**验证**：`G34`（新增，4 条断言）——首请求 503 → 上游恢复 → 9 s 内回到 200，且台账出现车道级 pass 刷新。

### 同轮加固

- `metrics.lanePrecheckRecovered / lanePrecheckMiss` 显式初始化并计数；
- `LANE_PRECHECK_MISS` 台账（区分"车道没恢复"与"保活没跑"）。

## 未发布（计划 v0.1.9）— 2026-11-05 判正增强（A）

**目标**：不换上游（用户硬约束），在唯一可用车道上把"这是谁在回"判得更准。

### 新增两条逐响应判据（与业务流量同桶、不需额外请求）

| 判据 | 官方 | 中转 | 稳定性 |
|---|---|---|---|
| `server` 响应头 | `openresty` | `cloudflare` | 各 3/3 |
| **顶层键顺序** | 35 键 serde 顺序 | 18（或 17，`reasoning` 条件回显）键另一套顺序 | 各 3/3 |

判法用 **LIS（最长递增子序列）+ 键集覆盖率**，不要求长度全等——第一次实现要求全等，
真实流量（17 键）全被判 `unknown`，已修正为：键数<10 不判、覆盖率≥85%、LIS≥95%。

### 效果（诚实版）

- **生产实测**：`x-gate-proof` 从"无依据的 `unknown`"变成**有依据的 `unverified`**
  （`keyOrder:{relay:1}` + `server:{cloudflare:1}`）。这是标注质量提升，不是"让 flash 变官方"。
- 在 flash 车道上**永远不可能判 `verified`**——它本来就是中转。想要 `verified` 只有换上游（被禁）。
- 新增能力：**伪装升级告警** `RELAY_MIMICS_OFFICIAL` —— 中转头（cf-ray/cloudflare）同时出现官方 35 键骨架时触发。
  这把"它开始模仿官方信封"本身变成信号，而不是等它模仿成功。

### 不参与放行

`proof` 只影响交付标注（`x-gate-proof` / `health.evidence.proof` / 台账 `proofEvidence`），
**不改变任何 200/503 判定**。所以本轮零可用性风险。

### 验证

`verify` **534 / 0**（AP1–AP15）、`coverage` **197 / 0**（G33 覆盖官方/中转/伪装三态）、`regress` 全绿。

## 未发布（计划 v0.1.9）— 2026-11-05 阶段一/二：可诊断性 + 判负即切换

**先纠正上一轮的一个错误结论**：说「缺 `GATE_UPSTREAMS` 才能切换」不准确。
实测（mock 首车道 HEX32）证明**同 host 多车道本来就能判负换道**（`attempts=2`，第三形态 → 次车道 → 200）。
跨 host 才需要 `GATE_UPSTREAMS`。

### 阶段一（P0，已完成）

**① 客户端中止归类**：`AbortError` 此前一律记 `HANDLER_ERROR`，而文档写「出现即 bug」——
24h 内实测误报 2 次。现在记 `CLIENT_ABORTED`（带 path/elapsedMs），并且在 `res.on('close')` 里落台账：
内层 `if (clientGone.signal.aborted) return` 会吞掉异常，顶层 catch 只兜未捕获路径，**close 那条才是主记录**。

**② 分段计时**：台账只有 `elapsedMs`，`elapsed − Σattempts.ms` 的 p90 有 1.7s 无法归因。
现在四段采样（保留最近 300 条）：

| 段 | 口径 |
|---|---|
| `precheckMs` | 请求进来 → 预检结论落定（缓存命中同样算落定） |
| `upstreamMs` | 预检完 → 上游响应头 |
| `gateMs` | 响应头 → 交付闸写完响应头 |
| `streamMs` | 写完头 → 响应结束（流式回传 + 客户端消费） |

`/gate/health.phase` 给 p50/p90；`PASS` 台账带 `phase` 快照。测试断言「四段之和 ≈ 总耗时」（不重不漏）。

### 阶段二（已完成）

**③ 车道级预检（per-lane）**：`runShapeProbe(lane)` / `precheck(proto,{lane})`，
缓存键 `proto@lane`；新增 `precheckLanes()` 编排：

- 单车道（或 `GATE_PERLANE_PRECHECK=0`）→ **直接退化为原来的 `precheck(proto)`**，行为逐字节不变；
- 多车道 → 并行探每个车道，聚合语义「任一 pass 即整体 pass」，全 fail 才 fail；
- 每条 `PRECHECK` 台账记 `lane`，可归因。

**④ 交付闸按「赢下车道」判定**：`pgate.byLane` 带上逐车道结论，`deliver()` 用
`dgate.byLane.get(model).verdict === 'pass'` 决定是否交付，而不是全局 `allowAllLanes`。
这修掉了「首车道预检 fail → 整条请求被打死、即使次车道已通过预检并被选中」这个结构缺陷。

**⑤ 影子观测脚本** `scripts/multilane-shadow.mjs`：在副端口起「官方信封优先」双车道，
按间隔发极小请求采样 winner / attempts / idShape，产物写 `gate/logs/tests/`，不动生产。

### 实测（真实上游，影子端口）

- `deepseek-v4-pro` 车道返回 **裸 UUID4 + 26 字段 → `verdict=official`**（`IMPL_VECTOR` 显示 `goStack=false`，
  即走原生校验）；`deepseek-v4.1-flash` 恒为 `resp_uuid4` → 只能是 `PASS_BY_PROOF`。
  **结论：形态可区分，且 pro 车道在现有判据下被判 positive**——这为「判负即切换」提供了真实目标。
  影子观测 4/4 轮全部落 pro（`scripts/multilane-shadow.mjs`，产物在 `gate/logs/tests/`）。
- 判负换道端到端（G32，mock 驱动）：首车道 HEX32 → 次车道交付 → 200，`attempts=2`，
  `BLOCKED_PRECHECK_NOT_PASS=0`，两条车道各有 `PRECHECK lane=` 记录。
- **分段计时的第一组真相**（生产，重启后 3 条真实请求）：
  `precheck p50 1ms / p90 12ms`、`upstream p50 1171ms / p90 3474ms`、**`gate p50 1ms / p90 1ms`**、
  `stream p90 1353ms`。→ 此前 `elapsed − Σattempts.ms` 的 1.7s 尾部**不是门控开销**，
  而是上游生成 + 流式回传；门控自身在毫秒级。

### 验证

verify **514 / 0**（新增 AO1–AO10）、coverage **190 / 0**（新增 G31 中止归类+分段、G32 判负即切换）、
`regress -IncludeSoak` **全部通过**（含修掉的 `R1 热启动` 相对判据抖动：加 4s 绝对兜底）。

## 未发布（计划 v0.1.9）— 2026-11-05 事故修复：证据过期导致全站 503

**16:26 全站 503，不是判据判负，是"证据过期"。** 这一轮修的是可用性与可诊断性，
同时堵掉一个 fail-open 隐患。

### 事故复盘

| 时刻 | 事件 |
|---|---|
| 13:42:49 | 刷新任务写入快照（正常） |
| 14:42 / 15:42 | 计划任务未产出新快照（`StartWhenAvailable` 未开 → 错过不补跑） |
| 15:42:49 | 快照越过 `GATE_EVIDENCE_MAX_AGE_MS=7200000`（2h）→ 此后任何 responses 请求都会被拒 |
| 16:26:47 | 第一条业务请求 → `503 gate_assurance_unmet`（`reason=snapshot_missing_or_stale`，`ageMs=9,838,540`） |

关键事实：报文里 `canary:{score:10,max:10}`、`proto_evidence:true` 都是好的——**拦人的是"过期"，不是"不合格"**；
而报文同时打印 `assurance:"label"`，看起来像"标签模式却拦截"的 bug，实际拦截者是 `canary_policy:"require"`。

### 修复 1：门控侧自愈（不再需要人工救）

`GATE_EVIDENCE_AUTO_REFRESH`（默认开）：判定 stale/missing 时，**在后台**用同进程调用
`runEvidence()` + `scoreEvidence()` + `writeSnapshot()` 补一次证据，不 spawn 子进程（保持"0 依赖 / 无子进程"审计口径），
也不阻塞本次响应（本次仍 fail-closed）。冷却 `GATE_EVIDENCE_REFRESH_MIN_MS`（默认 2 min），失败写台账
`EVIDENCE_REFRESH_FAIL`。
效果：同类故障从"小时级停摆"变成"一次刷新自愈"。实测（真实上游）：
整轮 `runEvidence` **48.1s**，自愈快路径（跳过 EV7/EV8/EV10，canary 10→4）**23.0s**，
自愈完成后 `stale=false`、`canary=4/4`、下一次请求 `200 pass-by-proof`。
快路径被跳过项打 `skippedReason=fast_refresh`，不进分母，不会把"没测"当"不达标"。

### 修复 2：报文说清"谁拦的"

`gate_assurance_unmet` 报错体新增 `blocked_by`（`canary_evidence` / `canary` / `canary_unproven` / `l0` /
`assurance_strict` / `validator`）、`refresh_started`、`evidence_max_age_ms`、`retryable:true`；
响应头新增 `x-gate-refresh: started`。文案从「官方性证据未达标」改为「被【<谁>】判定不可放行（<原因>）」。
台账 `ASSURANCE_UNMET` 同步记录 `blockedBy` 与 `canarySkipReason`。

### 修复 3：canary `skipped` 的 fail-open 洞

`skipped` 有两种来源，旧实现都当通过：目标即官方（合理）、**缺 `DEEPSEEK_API_KEY` 基线**（不合理 ——
无法证明模型族，却放行）。实测复现：在没继承该变量的终端里手工跑 `audit-lane --write`，
快照变成 `canary 0/0 skipped`，而 `require` 依旧放行，等于"防换模型"这条硬闸静默失效。
现在 `EV13` 记录 `skippedReason`，只有 `official_target` 允许放行；
`no_baseline_key` / 旧快照的 `legacy_unknown` → `503 canary_unproven_*`。

### 修复 4：计划任务不再静默停摆

`scripts/install-refresh-task.ps1` 注册后显式设置 `StartWhenAvailable=True`、`DisallowStartIfOnBatteries=False`、
`StopIfGoingOnBatteries=False`、`ExecutionTimeLimit=PT10M`、`MultipleInstances=IgnoreNew`。
（原先这几项是系统默认：错过不补跑，正是本次停摆的成因。）

### 修复 5：`ocg doctor` 会自己喊

新增三行体检：**证据快照**（新鲜度 `age/maxAge` + canary 分数）、**证据自愈**（开关/尝试次数/最近结果/失败原因）、
**canary 基线**（`skippedReason≠official_target` 直接报 ❌）。此前这三项全无，所以停摆两小时无人知晓。

### 测试

- `test-coverage` 新增 **G30**（9 项）：过期 → 503 + `blocked_by` + `x-gate-refresh` → 后台刷新完成 → 快照转新鲜 →
  理由从"过期"变"缺基线"；旧快照 `legacy_unknown` 拒绝；`official_target` 放行（直连不自锁）。
  同时修正套件自身缺陷：`mock.close()` 原先写在所有用例之前，导致后追加的 G29/G30 连不上 mock（ECONNREFUSED）。
- `verify-patch` 新增 **AM1–AM18**，覆盖自愈开关/冷却/单飞/写回/失败留痕/`blocked_by`/health 字段/EV13 语义。
- 离线：**481 / 0**（verify）与 **175 / 0**（coverage）。

## 未发布（计划 v0.1.9）— 2026-11-05 审计修复

**这一轮不加判据，只修「能骗过测试的缺陷」。** 起因：`regress.ps1 -IncludeSoak` 对真实上游必红，
顺藤摸出 11 处不一致——文档承诺 vs 代码行为、测试 vs 生产、字段名 vs 语义。

### 修复：`test-risk.mjs` 两处真 bug（regress -IncludeSoak 失败的根因）

| 缺陷 | 现象（复现） | 修法 |
|---|---|---|
| 不带 `x-gate-token` | 生产与影子都显式启用了 `GATE_TOKEN` → 每个请求 401，`R1 首请求成功` 直接 FAIL | 与其他套件一致，从 `process.env.GATE_TOKEN` 取并发送 |
| `Math.max(...samples)` | 401 是毫秒级返回，60 s soak 攒出十几万样本 → 展开传参 `RangeError: Maximum call stack size exceeded`，真正的失败原因被爆栈掩盖 | 改 `reduce`；样本数与「连续失败」都设上限；首个请求失败即中止并打印鉴权提示 |

### 新增：按声明长度提前拒绝（不再被「只发头不发体」占住槽位）

`Content-Length` 超 `GATE_MAX_BODY` 时立刻 413（报错体带 `declared: true`），不必等 body 到齐。
旧实现只在**实际收到**超限字节后才拒，于是 6 条挂起连接就能占满 `MAX_CONC` 槽位（默认要等
`GATE_BODY_IDLE_TIMEOUT_MS=120 s`），也与 README「超限即 413 + x-gate-fatal」不一致。

### 修正：health / 台账字段「同名不同义」

| 旧字段 | 问题 | 现在 |
|---|---|---|
| `deliverableShapes` | 恒含 `resp_`，但那只在 `GATE_RESP_SHAPE_STRICT=0` 回退时才生效 → 会被读成「任意 resp_ 都放行」 | 新增 `respShapeStrict` + `deliverableShapesEffective`（严格模式自动剔除 `resp_`） |
| `ttl` | 实际是 matrix 探测结论的复用窗口，与旁边 `precheckTtlMs`（15 s）极易混读 | 改名 `matrixTtlMs` |
| `usageKeysRequired` | 恒返回中转 7 键（含 `cost`/`opencode`），像是「必须含 cost 才合格」——正好相反 | 按最近实测剖面返回（官方 5 键 / 中转 7 键），并新增 `usageKeysByProfile` 全量表 |
| 台账 `proofTrust` | 取的是预检结论（`trust='full'` 表示预检 pass），却与 health 的 proof 信任同名 → 台账 full / health unknown 看似矛盾 | 台账改 `precheckTrust`；health 的 `proofTrust` 语义不变 |

### 修正：日志轮转不再污染共享目录

旧实现固定写 `LOG_DIR` + `gate-<ts>.jsonl`：影子/测试实例（`GATE_LOG_FILE` 指到别处）一旦超过
`GATE_LOG_CAP`，自己的历史块会落进共享 `gate/logs`，还会被对方的 prune 顺手删掉——
实测有 4 个 5 MB 的 8799 残留块躺在生产目录里。现在轮转只落在台账自己所在目录、只 trim 同前缀。

### 测试卫生

- 测试台账统一写 `gate/logs/tests/`（原先 900+ 个 `cov-*.jsonl` 与生产台账同目录）；
- `G6 快照损坏` 用例原先改写的是**生产** `gate/logs/matrix.json`，而该实例读的是自己的
  `GATE_SNAPSHOT` → 既污染生产又其实没测到目标路径；现在改写实例自己的快照；
- `test-risk` 的「超上限」用例改为从 `/gate/health` 读实际上限（生产 24 MiB / 出厂 16 MiB 都成立），
  并新增 `R3b` 声明长度攻击用例。

### 文档（此前与代码不符）

- README 版本与下载包名对齐 `v0.1.8`（此前 README 写 `v0.1.7`，CI「版本一致性」自 `e91d23e` 起连续失败）；
- README 请求体上限段落澄清：**出厂默认 16 MiB**，24 MiB 需按四参数联动 `setx`（`install.ps1` 不覆盖）；
- `.env.example` 的 `GATE_PRECHECK_TTL_MS` 注释 90000 → 15000（与代码一致）；
- `docs/CONFIG.md`：`GATE_PROBE_DEADLINE_MIN` 5000 → 8000；413 说明补 `declared`；轮转说明补齐；
- CI 步骤名与 README 不再写死断言数（写死过两次，之后都漂了）。

### 验证

- 离线：`verify-patch` **463 / 0**、`test-coverage` **165 / 0**（新增 G29 覆盖声明长度闸与 health 语义）；
- 真实上游：`regress.ps1 -IncludeSoak` **全部通过**（suite 26 / pollution 11 / security 20 / cache 8 /
  multimodal 7 / real 18 / risk 17，均 0 失败）。

## v0.1.8 — 2026-11-04

**不是"又多了一批判据"，而是把「能不能证明这条通道是官方」这件事第一次说清楚了。**

### 一句话总结

新增三层可核验证据（L0 端点指纹 / MX messages 判据 / CY 随机 canary），
把其中唯一稳定的那条（canary）接成硬闸；同时修掉两个会打挂服务的缺陷。

### 新增：L0 端点指纹（5 条，零 token、秒级）

| ID | 判据 | 官方 | 中转 |
|---|---|---|---|
| L0-1 | `GET /v1/models` 的 `owned_by` + 条目数 | `deepseek` / 2 条 | `opencode` / **28 条**（含 glm/gpt/grok/claude/qwen） |
| L0-2 | 响应头 `x-ds-trace-id` | 有 | **无** |
| L0-3 | 第三方头 `cf-ray` / `x-zen-model` / `x-opencode-log-id` | 无 | 有 |
| L0-4 | 无认证 401 文案 | `Authentication Fails (governor)` | `{"type":"server_error"}` |
| L0-5 | 试跑 `glm-5.2` | 400 | **200（能跑通 = 转售池）** |

### 新增：MX messages 判据（6 条）

M1 id 形态 / M2 `cost`+`opencode` / M3 `service_tier` / M4 额外 `(request id: 2026…)` /
M5 `Upstream request failed` 前缀 / **M6 官方范围文案 + UUID4 `request_id`**。

实测：官方 6/6 全过；中转 1/6（仅 M6 通过，说明请求确实到达官方校验器）。

### 新增：CY 随机 canary（本次核心，已接成硬闸）

每次 audit 取 10 条随机串，同时打官方与目标端，比对 `usage.input_tokens`。

判别力实测（同一随机串）：

| 目标 | tokens |
|---|---|
| 官方 deepseek-flash | **39** |
| 官方 deepseek-chat | **13** |
| 中转 glm-5.2 | **21** |
| 中转 deepseek-v4.1-flash | **39** |

稳定性：24 次采样 24/24 一致。`GATE_CANARY_POLICY=require` 下不一致即
`503 gate_assurance_unmet`（reason=`canary_mismatch`）。

### 新增：assurance 四档 + 逐响应官方痕迹

```
GATE_ASSURANCE = off | label | probe | strict
x-gate-proof  = verified | unverified | unknown
x-gate-canary = 10/10 | skipped
```

当前 opencode 车道：`x-gate-proof` **恒为 `unverified`**——这是诚实标注，
不是故障：中转抹掉了官方痕迹，我们只能证明"模型族没换"。

### 修复：assurance 耦合导致的全站停机（已实测复现）

原实现所有请求都看 `validator.reachable = V1(responses) || V2(messages)`；
而今天 V1=false，于是"能否放行 responses"完全取决于 messages 探针 →
messages 的实现 B 窗口里，一次 M6 失败就把全部 responses 流量打成 503。

现在按协议取证据：responses 只看 `validator.responses`，messages 只看 `validator.messages`；
字段缺失视为 `unknown`（不拦），快照过期视为 `stale`（拦）。

### 修复：canary skipped 自锁

`EV13` 在"目标即官方"或"缺 `DEEPSEEK_API_KEY`"时标 `skipped`，
而 `canary.ok=false` → `require` 下会把直连流量全部 503。
现在 `skipped` 视为通过（直连不能因为"无需比对"而被自己拒绝）。

### 新增：请求体上限 16 → 24 MiB 与四参数联动

实测上游接受 ≥20.97 MiB；真实 15.33 MB 请求中位 19.3 s。
**只抬 `GATE_MAX_BODY` 不够**：`GATE_ATTEMPT_HARD_CAP_MS`（180 s）会先掐断，
必须四参数联动（`MAX_BODY` / `UPSTREAM_TIMEOUT` / `TOTAL_BUDGET` / `ATTEMPT_HARD_CAP`）。
413 报错体现在带 `actual_bytes` 与 `x-gate-fatal: 1`（提示重试无意义）。

### 重要更正：此前记录的「中转注入 26 token」是对比错误

当时拿官方 `deepseek-chat`（非推理，5 token）对比中转 `deepseek-v4.1-flash`（推理，31 token）。
同模型同参数实测：responses / messages / chat 三协议 token **逐条一致**，**没有任何注入**。
详见 BASELINE B20。

### 结论：messages 不做业务通道（数据支撑）

| 项 | 窗口 A | 窗口 B |
|---|---|---|
| id | 53 hex | **32 hex** |
| 参数校验（M6） | ✅ 16/16 | ❌ **0/20** |
| 多轮工具 `input_tokens` | — | 官方 191 vs 中转 **63** |

而 responses 多轮工具 **319 = 319（3/3 一致）** —— 三个协议里最忠实的通道。
细节见 BASELINE B21/B22。

### 新增：证据自动刷新（必须配）

`canary=require` 依据快照，过期会 fail-closed（实测 13h 旧快照 → 全量 503）。
新增 `scripts/install-refresh-task.ps1` 一键安装每小时 `ocg audit-lane --write`。

### 测试

```
verify-patch   401 → 427  （+AH/AI/AJ 共 26 条单源断言）
test-coverage  130 → 151  （+G21/G22/G23/G24/G26/G27）
其余套件全绿
```

## v0.1.7 — 2026-11-01

**纯文档版，不改任何放行逻辑、不改任何阈值。** 记录两条"判据不可靠"的实证，供以后复盘。

### B14 升级：`input:[]` 的四天轨迹（探针不可靠的硬证据）

| 日期 | `input:[]` 结果 |
|---|---|
| 10-29 | `400 input: at least one message is required`（8/8 稳定） |
| 10-30 | `400` / `503` 各半（3:3） |
| 10-31 | `503 Endpoint is unavailable`（2/2） |
| 11-01 | **`400` 又回来了**（2/2） |

同一条探针在两个状态之间**来回横跳 4 次**。`input:12345` 也从 `400 input: expected an array`
漂成 `503`；`reasoning.effort:"bogus"` 在 `200`（忽略）与偶发 `400 [InvalidParameter]` 之间摆动。
→ 三者**永久禁止**进入预检与交付闸，只作告警信号。

### B15 新增：`messages` 的 id 生成器四天换三次

```
UUID4（10-27，间歇） → TS13（10-28 ~ 10-31，8/8 稳定） → HEX32（11-01，8/8）
```

同一条通道**四天内换过三种 id 生成器**，且都是整池切换（不是概率抖动）。同一天
`messages` 的 `max_tokens=0` 也从 `200`（不校验）变成 `400`（拒绝），说明该池换过一次实现。

结论：**id 形态只能做"当前已知形态"的否证，永远不能反推"是官方"**——形态由网关生成，
与后端身份无关。这也解释了为什么 `trustLevel` 的天花板是 `medium`。

### 当天门控运行数据（日志隔离后的干净数字）

```
生产实例 pid 14216（今日仅此一个）
预检  pass 244 / unknown 4（网络抖动）/ fail 0
交付  PASS_BY_PROOF 1 / BLOCKED 0
指纹  FP_OK 1 / FP_MISMATCH 0
向量  IMPL_VECTOR_DRIFT 21 + IMPL_GO_STACK 20（仍偏离基线 422,422,200,503,503）
```
## v0.1.6 — 2026-10-31

### 安全修正：`/gate/admin/drain` 的最小权限（v0.1.5 引入的缺陷）

自查发现：v0.1.5 的 drain 端点同时接受 `GATE_TOKEN` **和** `GATE_OBS_TOKEN`。
`GATE_OBS_TOKEN` 的定位是**只读观测凭据**（脚本、面板可能共享），授予它停门控的能力
等于把「读权限」提权成「拒绝服务权限」。

收紧为**只认 `GATE_TOKEN`**：
- 未配置 `GATE_TOKEN` → `403 gate_drain_disabled`（即使配了 `GATE_OBS_TOKEN` 也禁用）；
- `ocg stop/restart` 同样只读 `GATE_TOKEN`，缺失时给出明确提示。

### drain 端点防御实测（v0.1.6）

| 场景 | 结果 |
|---|---|
| 无 token（模拟同机进程 / 网页表单） | **403** |
| 错误 token | **403** |
| 跨源 `Origin: https://evil.example`（无 token） | **403**，且无 `Access-Control-Allow-Origin` |
| DNS rebinding 式 `Host: evil.example` | **421 gate_bad_host** |
| `GET /gate/admin/drain` | **405** |
| 门控存活 | ✅ |

### 测试

```
verify-patch  345 / 0   （+1 条 AB2b：drain 只认 GATE_TOKEN）
test-coverage  92 / 0   （+2 条 G17：仅 OBS token 时 drain 仍 403）
```

### 未做（与 v0.1.4 相同，仍是剩余两项治本工作）

- Release 产物无签名（sha256 与 zip 同渠道）；
- key/token 明文存于 `HKCU\Environment`。
## v0.1.5 — 2026-10-31

### 优雅停止（drain）+ `ocg stop` / `ocg restart`

**问题**（2026-10-30 17:07 实测丢请求）：`Stop-Process -Force` 强杀门控 → 在途连接被 RST →
客户端只看到 `Connection error / Terminated`；客户端 `retryPolicy.maxRetries=1`、退避 800ms，
落不到新实例起来的窗口里，于是整轮失败。**Windows 上 `SIGTERM` 不成立**（Node 映射为强制终止），
信号式 drain 不可行。

**方案**：门控新增 `POST /gate/admin/drain`（需 `GATE_TOKEN` 或 `GATE_OBS_TOKEN`；
两者都没配则 403 禁用，防止本机任意进程停门控）：

1. `server.close()` 停接新连接（顺带 `closeIdleConnections`）；
2. 等在途响应写完（`gateInflight` 计数，上限 `GATE_DRAIN_MAX_MS`，默认 15s）；
3. 写快照 → `exit(0)`；监护进程 1.5s 内拉起。

排空期间到达的新请求快速返回 `503 gate_draining` + `retry-after: 2`，让客户端重试落到新实例。

配套 CLI：
- `ocg restart`：drain → 等退出 → 等新实例 health=200，打印中断时长；>3s 时提示提高 `maxRetries`；
- `ocg stop`：drain + 写 `stop.flag`（与 `ocg-supervise.mjs` 的 `STOP_FLAG` 同路径），监护不再拉起；
- `ocg start`：自动清除 `stop.flag`。

实测（真实上游，在途请求 1 个）：**中断 258ms，在途请求正常 200 完成**。

### 修复：测试门控污染生产台账

`gate/test-coverage.mjs` 启动的子门控此前不设 `GATE_LOG_FILE`，所有 `STARTUP_SELFTEST`、
`FP_MISMATCH`、`PASS_BY_PROOF` 都写进了生产的 `gate/logs/gate.jsonl` —— 历史累计 **248 条
`STARTUP_SELFTEST`、240 个不同 pid**，导致基于台账的日常统计（我给你的那些数字）不可信。
现在测试实例写 `gate/logs/cov-<port>.jsonl`。

### 客户端重试（P1，非仓库改动）

两台 profile（web / desktop）的 `retryPolicy.maxRetries` 由 `1` 提到 `2`
（重试点 ≈0.8s / 4.8s，覆盖约 5 秒的中断窗口）。备份：`cordis.patch.yml.bak-retry2-<时间戳>`。
**需重启 dsh 生效。**

### 测试

```
verify-patch  344 / 0   （+12 条 AB 段断言）
test-coverage  90 / 0   （+6 条 G17：drain 禁用/未授权/受理/在途不丢/进程退出）
```
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