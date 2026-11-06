# BASELINE — 判据基线

这个文件回答一个问题：**门控凭什么认为"这是官方后端"？**

所有判据都来自对 `opencode.ai` 网关的黑盒观察，不是官方文档承诺。上游一改，这里就是第一现场。

代码里的唯一来源是 [`gate/baseline.mjs`](../gate/baseline.mjs)。`gate/oc-gate.mjs` 与
`probe/official-detect.mjs` 都从它 import；`verify-patch.mjs` 会断言别处不得复制字面量。

## 判据表

| # | 判据 | 观测事实 | 实测日期 | 失效时改哪 |
|---|---|---|---|---|
| B1 | `responses` id 形态 | 官方直出 = UUIDv4（37/37）；第三方 = `HEX32` / `resp_` / `chatcmpl` / `gw-` / 纯数字（38/38 非 UUIDv4） | 2026-10-19 | `baseline.mjs` 的 `ID_UUID4`；分类逻辑在 `shapeOf()` |
| B2 | 可交付形态白名单 | 只有 `UUID4` 与 `resp_uuid4` 可交付；`resp_uuid4` 还必须叠加协议级背书。`resp_` 后缀不符合 UUID4 位模式时判 `resp_bad` 拒绝（2026-10-26 起） | 2026-10-26 | `baseline.mjs` 的 `DELIVERABLE_SHAPES`、`oc-gate.mjs` 的 `UUID4_BITS` |
| B3 | `responses` 主判据（e1s） | **2026-10-27 起**：`reasoning.effort="bogus"` → 官方 serde 原话 `Failed to deserialize the JSON body into the target type: reasoning_effort: unknown variant …` + `(request_id: <uuid4>)`，状态 422；实测 5/5 | 2026-10-27 | `baseline.mjs` 的 `E_SERDE_MSG` / `E_SERDE_EXTRAS` |
| B3-old | `responses` e1（**已退役**） | 缺 `input` 返回 serde 原话 + UUID4 `request_id`；2026-10-27 起网关自行拦截（`503 Endpoint is unavailable`），不再穿透 | 2026-10-23 → 10-27 失效 | 保留常量 `E1_MSG` 供对照，勿再作判据 |
| B4 | `messages` 状态码指纹 | 9 项非法参数请求 → `400,400,400,400,400,400,422,422,422`（400=业务层，422=反序列化层） | 2026-10-19 | `baseline.mjs` 的 `MSG_FINGERPRINT` |
| B4-drift | `messages` 指纹漂移 | **2026-10-27 实测** `200,400,400,400,400,500,200,500,422`（`max_tokens=0`→200、缺 messages→500、非法 role→200），且正常响应 **5/8** 的 id 是 53 位 hex（非 UUID4）→ 该协议混入非官方实现，**默认封禁** | 2026-10-27 | `MSG_FINGERPRINT_2026_10_27`（留档，未启用）；解封用 `GATE_ALLOW_MESSAGES=1` 并重新标定 |
| B5 | `chat` 协议 | 无可用的零成本判据，默认封禁 | — | 保持封禁（`GATE_BLOCK_PROTOS` 默认 `chat`） |
| B5b | `messages` 封禁开关 | 无条件封禁，除非显式 `GATE_ALLOW_MESSAGES=1`（不随 `GATE_BLOCK_PROTOS` 变化） | 2026-10-27 | `oc-gate.mjs` 的 `BLOCKED_PROTOS` |
| B6 | 网关拦截话术 | `Upstream request failed` / `Endpoint is unavailable` / `Model is unavailable` → 归为 `gateway`，既不算官方也不算第三方 | 2026-10-19 | `baseline.mjs` 的 `GATEWAY_BLOCK` |
| B7 | id 形态不可控 | `resp_` 与 UUIDv4 由上游**双池随机**决定，同一 header 组合前后两次结果可不同；不存在"强制 UUIDv4"的旋钮 | 2026-10-23 | 不要试图"修"，这是上游行为 |
| B8 | 探针必须非法 | 只有"非法请求"能拿到可识别的错误；"合法请求"必须正常出词。因此中间层可用的分类器是「这个请求合法吗」，随机化探针参数/提频/加第二判据/加影子探针**全部无效** | 2026-10-23 | 已评估并否决，不要重做 |
| B9 | `responses` 形态判据（现行主判据） | 成功响应 id 必须是 `resp_uuid4` 位模式（38/38 稳定）；errors 类判据已全部失效（参数校验随实现池轮询，同一探针 422↔200） | 2026-10-27 | `oc-gate.mjs` 的 `runShapeProbe()`；基线 `USAGE_KEYS_REQUIRED` |
| B10 | `responses` usage 键集 | 必须含 `cost,input_tokens,input_tokens_details,opencode,output_tokens,output_tokens_details,total_tokens`（20/20 稳定） | 2026-10-27 | `baseline.mjs` 的 `USAGE_KEYS_REQUIRED` |
| B11 | 实现指纹向量（**仅观测**） | 5 个参数探针的返回码序列，2026-10-27 实测基线 `422,422,200,503,503`；与基线不符只告警 `IMPL_VECTOR_DRIFT`，**不参与放行** | 2026-10-27 | `baseline.mjs` 的 `IMPL_VECTOR_2026_10_27` |
| B14 | 已**永久停用**的探针（2026-10-30 首次证伪，2026-11-01 四次复验） | **`input:[]`** 的四天轨迹：`400 input: at least one message is required`（10-29，8/8 稳定）→ `400/503 各半`（10-30，3:3）→ `503 Endpoint is unavailable`（10-31，2/2）→ **`400` 又回来了**（11-01，2/2）。**同一条探针在两个状态间来回横跳 4 次**，这是"报错文本类判据不可靠"最硬的实证。<br>**`input:12345`**：10-31 起从 `400 input: expected an array` 漂成 `503`。<br>**`reasoning.effort:"bogus"`**：200（忽略）↔ 偶发 400 `[InvalidParameter]` 透传（池级抖动），11-01 又回到 200 2/2。<br>→ 三者**永久禁止进入预检与交付闸**，只可作告警信号。 |
| B13 | 每响应指纹（**交付闸，2026-10-29**） | 非流式 `responses` 交付前校验 6 项结构事实：必需字段全在且无未知字段（15+3 口径，见 B13 细则）、`usage` 七键、`total=input+output`、`output item id` 形如 `rs_/msg_/fc_`+32hex、`incomplete` 必有 `reason`、`content` 元素键 ⊆ `{annotations,logprobs,text,type}`；请求带 `reasoning` 时响应必须回显 `reasoning`。流式校验事件家族（`created/in_progress/output_item.added/output_item.done` 且终止事件 ∈ `{completed,incomplete}`）+ `sequence_number` 单调。**实测 flash 车道 10/10 全绿**。策略 `GATE_FP_POLICY=retry|block|warn`（默认 retry） |
| B15 | `messages` 的 id 形态演进（**为什么 id 永远不能当正向判据**） | `UUID4`（10-27，间歇）→ `TS13`=13 位毫秒戳 + 40 hex（10-28 ~ 10-31，8/8 稳定）→ **`HEX32`**（11-01，8/8）。同一条通道**四天内换过三种 id 生成器**，且每次都是整池切换（不是概率抖动）。结论：id 只对"当前已知这一种形态"构成否证价值（B10/B11），**不能反推"是官方"**——因为形态由网关生成，与后端身份无关。<br>同日 `messages` 的 `max_tokens=0` 也从 `200`（不校验）变成 `400`（拒绝），说明该池换过一次实现。 |
| B12 | 结构闸 | 非流式 `responses` 响应必须含非空 `message`（或工具调用 item）；只有 `reasoning` → 拒 `gate_structure_bad`。被 `max_output_tokens` 截断且有正文 → 交付并打 `x-gate-truncated:1` | 2026-10-27 | `oc-gate.mjs` 的 `deliver()` 结构闸 |

## 上游变化时怎么判断是哪条断了

```powershell
node bin\ocg.mjs doctor          # 看 judgeAgeMs / lastJudgeOk
curl.exe -sS http://127.0.0.1:8787/gate/alerts
node probe\official-detect.mjs --lite    # 只跑 E 类，0 token
```

| 现象 | 最可能断的 | 下一步 |
|---|---|---|
| 全部 503，`shape:fail idShape=other…` | B9 | 上游换了 id 生成器；抓一次响应 id，确认是否仍是 `resp_`+UUID4 位模式 |
| 全部 503，`shape:fail usage 缺键 …` | B10 | 网关改了注入字段，对照 `USAGE_KEYS_REQUIRED` 重新标定 |
| 个别 503 `gate_structure_bad` | B12 | 上游只回了思考没有正文；看台账 `STRUCTURE_BAD` 的 `incompleteReason` |
| 告警 `IMPL_VECTOR_DRIFT` / `IMPL_GO_STACK` | B11 | 上游实现换了/掺入 Go 实现；不影响放行，但需要人工评估 |
| 全部 503，指纹 `410×9` | 模型被下线 | 抓一次上游 410 的 `metadata.replacement`，按新别名改 `GATE_CHAIN` |
| 部分交付，id 落 `other` | B1 | 把新形态加进 `shapeOf()` 并告警，观察一天 |
| 预检 pass 但交付 503 | B2 | 白名单与预检结论打架，先看 `/gate/metrics` 的 `rejectedThirdShape` |

## 改动纪律

1. 改任何常量 → 同步更新本表日期与 `baseline.mjs` 的 `OBSERVED_AT`；
2. 改判据属于 **minor** 版本变更，CHANGELOG 要单独置顶写清"可能影响交付率"；
3. 不改架构的前提下，先改常量；改架构要先写清为什么常量方案不成立。

## B16 证据链标定（2026-11-02 实测）

| 项 | 官方 api.deepseek.com | opencode 车道 |
|---|---|---|
| EV1 `GET /v1/user/balance` | 200（`balance_infos`） | 404 |
| EV2 `POST /v1/completions` | 400 指向 `beta api` | 404 |
| EV3 `temperature:9` | 400 `valid range of temperature is [0, 2]` | 400（非范围文案） |
| EV4 `top_p:2` | 400 `valid range of top_p is (0, 1.0]` | 200 |
| EV5 证书 | subject=api.deepseek.com，issuer=TrustAsia，SAN 单域名 | subject=opencode.ai，issuer=Google Trust Services，SAN 含 wildcard |
| EV6 ALPN | h2 | http/1.1 |
| EV7 形态 | 35 字段 / 裸 UUID4 / usage 5 键 / 无 opencode 块 | 18 字段 / `resp_` 前缀 / 7 键 / 有 opencode 块 |
| EV8 serde | Rust：`max_output_tokens ... expected u32` | Go：`max_completion_tokens` |
| EV9 能力（background/top_logprobs/store/max_tool_calls） | 全部 200 | 全部 503 |

实测结论：官方 6/6（L1）+ 3/3（L2）；opencode 1/6 + 0/3。**L3（模型身份）两侧均为 `unproven`。**

## B17 模型族标定（2026-11-02 实测）

判据：EV10 分词一致性（10 类文本的 `usage.input_tokens` 与官方基线逐条比对）+ EV11 官方校验器模板（3 条错误文案 + UUID4 `request_id`）。

| 类别 | 官方 `input_tokens` | v4.1-flash | v4-pro |
|---|---|---|---|
| 纯中文 | 22 | 22 | 22 |
| 纯英文 | 18 | 18 | 18 |
| 中英混排 | 17 | — | 17 |
| 代码 | 21 | — | 21 |
| 数字 | 22 | — | 22 |
| 空白 | 9 | — | 9 |
| emoji | 19 | 19 | 19 |
| 长中文(40×) | 604 | — | 604 |
| 重复字符(3000×) | 379 | — | 379 |
| JSON | 24 | 24 | 24 |
| **EV10 一致率** | — | **10/10** | **10/10** |
| **EV11 校验器** | 3/3 | **0/3** | **3/3** |
| **family 判定** | `deepseek-official` | `deepseek-thirdparty` | `deepseek-official` |

结论：
1. 分词逐条一致 → 三条车道**都是 DeepSeek 模型族**（换 Qwen/Llama 必变分词）。
2. EV11 只有官方与 v4-pro 命中 → 说明请求**确实到达官方校验器**；flash 车道是本地/兼容层自行处理。
3. `v4.1-flash` 仍是兼容层形态（18 字段 / Go serde / 能力 503），但其分词一致，说明**它背后跑的也是 DS 权重**。
4. 权重托管方（官方 vs 自部署）**响应侧不可证**，`model.weights` 恒为 `unproven`。

## B18 请求体上限与延迟标定（2026-11-03）

### 上游能接受多大

用 `metadata` 填充（不 tokenize；注意上游会把 metadata **原样回显**，故耗时偏高）：

| 请求体 | 上游状态 | 耗时 |
|---|---|---|
| 16.78 MiB | 200 | 191.8 s |
| 20.97 MiB | 200 | 143.3 s |

**结论：上游上限 ≥ 20.97 MiB**，门控原先的 16 MiB 才是瓶颈。

### 真实请求的延迟（台账 14 个 >10 MB 样本）

| 体量 | 中位 | p90 |
|---|---|---|
| < 2 MB | 3.5 s | 6.3 s |
| 2–8 MB | 8.4 s | 17.3 s |
| 8–12 MB | 15.8 s | 30.8 s |
| > 12 MB | 21.8 s | 31.6 s |

**关键**：真实 15 MB 请求只要约 20 s；`metadata` 探针的 140–190 s 是"回显"造成的假象，不代表真实流量。

### 四个超时参数必须联动

实测踩到：只抬 `GATE_MAX_BODY` 不够——`GATE_ATTEMPT_HARD_CAP_MS`（默认 180 s）会先掐断：

```
20 MiB 请求 → 180.2 s 被硬上限切断 → 503
抬到 420 s → 284.4 s 被 REJECT_SHAPE_UNKNOWN 拒（响应太慢，首帧判定窗口耗尽）
```

**当前生产取值**：

```
GATE_MAX_BODY            = 25165824 (24 MiB)
GATE_UPSTREAM_TIMEOUT_MS = 120000   (120 s)
GATE_TOTAL_BUDGET_MS     = 150000   (150 s)
GATE_ATTEMPT_HARD_CAP_MS = 180000   (180 s，不变)
```

### 已知边界

- 真实请求 15 MB ≈ 20 s，24 MB 预估 30–40 s，均在 120 s 预算内；
- **超过约 150 s 才返回首帧的请求会被判 `REJECT_SHAPE_UNKNOWN`**（首帧判定窗口耗尽），这是 shape 预检的固有边界；
- 因此不要为了"极端大 body"继续抬上限——瓶颈会转移到首帧判定，而不是 body 限制。

## B20 L0 指纹与 messages 判据标定（2026-11-04）

| 判据 | 官方 api.deepseek.com | opencode /zen/go |
|---|---|---|
| L0-1 models | 2 条，`owned_by=deepseek` | **28 条**，`owned_by=opencode`（含 glm/gpt/grok/claude/qwen） |
| L0-2 `x-ds-trace-id` | 有 | **无** |
| L0-3 第三方头 | 无 | `cf-ray`、`x-zen-model`、`x-opencode-log-id` |
| L0-4 401 文案 | `Authentication Fails (governor)` | `{"type":"server_error",…}` |
| L0-5 `glm-5.2` | 400 | **200** |
| M1 messages id | UUID4 | 53 位 hex（递增） |
| M2 usage 包装 | 无 | `cost` + `opencode` |
| M3 `service_tier` | 有 | 无 |
| M4 额外 request id | 无 | `(request id: 2026…jGCQm7ig)` |
| M5 包装前缀 | 无 | `Upstream request failed: [invalid_request_error]` |
| M6 官方范围文案 + UUID4 | ✅ | ✅ **6/6** |

**汇总**：官方 `L0=5/5, MX=6/6, assurance=strict`；opencode `L0=0/5, MX=1/6, assurance=probe`。

### 2026-11-04 的重要修正

此前记录的「中转注入 26 token」是**对比错误**造成的误判：
当时拿官方 `deepseek-chat`（非推理，5 token）对比中转 `deepseek-v4.1-flash`（推理，31 token）。
同模型同参数实测后：

| 对比 | 官方 | 中转 |
|---|---|---|
| messages 均为 flash | 31 | **31** |
| responses 均为 flash（默认 reasoning） | 31 / 36 | **31 / 36** |
| responses（reasoning=none） | 5 / 10 / 10 | **5 / 10 / 10** |

**结论：三个协议均无注入，token 计数逐条一致。**

### 各协议能力矩阵（2026-11-04）

| 协议 | token 透传 | 校验器可达 | 工具 | 流式 |
|---|---|---|---|---|
| responses · flash | ✅ | ❌ 0/3 | ✅ | ✅ |
| responses · v4-pro | ✅ | ✅ 3/3 | ✅ | ✅ |
| messages · flash | ✅ | ✅ 6/6 | ✅ | ✅（标准 Anthropic SSE） |

## B21 messages 为何不能作业务通道（2026-11-04 定位结论）

排查过程踩到三个独立问题，最终结论是「架构上不允许」，不是 bug：

1. **candidates 类型混用**：若把 `candidates` 写成对象数组，下游 `const model = candidates[idx]`
   会把整个对象当模型名 → 上游收到 `{"model":"[object Object]"}` → 400 `Model is unavailable`。
   回显上游确认：`[real] path=/zen/go/v1/messages body={"model":"[object Object]",...}`
2. **多层闸门互相独立**：预检闸、候选筛选闸、交付闸各自判断，改一处仍会被另一处挡。
3. **根本原因**：`identity_whitelist`（身份白名单）在 `verdict==='third'` 且非 4xx 透传时**硬拒绝**，
   与 `allowAllLanes` 无关。

中转 messages 的成功响应：

| 项 | 官方 | 中转 |
|---|---|---|
| 响应 id | UUID4 | **53~62 hex（递增）** |
| usage | `service_tier` | `cost` + `opencode` |
| 响应头 | `x-ds-trace-id` | `x-opencode-log-id` |

即：**每个 messages 成功响应都必然被判 third**，要放行就只能放宽身份白名单——那等于放弃项目最核心的判据。

**结论**：messages 只作为**证据探针**（MX 判据），其 M6 已能证明"校验器可达"并写入快照；
业务通道保持 responses，messages 端点对客户端继续 `503 gate_proto_blocked`。

## B22 canary 判据与协议解耦（2026-11-04 收尾标定）

### 为什么需要 canary

今天遍历了"防换模型"的可用判据，只有**随机分词比对**是稳定的：

| 判据 | 稳定性 | 判别力 |
|---|---|---|
| M6（messages 官方校验器） | ❌ 窗口 A 16/16、窗口 B 0/20 | 判"是否走官方校验" |
| canary（随机串 input_tokens） | ✅ 24/24（跨实例一致） | 判"模型族是否被换" |

canary 的判别力实测（同一随机串）：

| 目标 | input_tokens |
|---|---|
| 官方 deepseek-flash | **39** |
| 官方 deepseek-chat | **13** |
| 中转 glm-5.2 | **21** |
| 中转 deepseek-v4.1-flash | **39**（与官方 flash 一致） |

→ 换模型必现差异；同模型逐条一致。

### 协议解耦（修复停机缺陷）

原实现：`assurance` 闸对所有请求看 `validator.reachable = V1(responses) || V2(messages)`。
今天 V1=false，于是"能否放行 responses"完全取决于 messages 探针 → **窗口 B 里一次 M6 失败就把全部 responses 打成 503**（已实测复现）。

修复后：

| 请求协议 | 只看 |
|---|---|
| responses | `validator.responses` |
| messages | `validator.messages` |
| 字段缺失 | `unknown` → **不拦**（只标注），避免把"没测过"当"不达标" |
| `stale`（快照过期） | 拦 |

### messages 为何仍不做业务通道

| 项 | 窗口 A | 窗口 B |
|---|---|---|
| id | 53 hex | **32 hex** |
| 参数校验（M6） | ✅ | ❌ 0/20 |
| 多轮工具 input_tokens | 未测 | **官方 191 vs 中转 63**（差 -128） |

而 responses 多轮工具 **319 = 319（3/3 一致）**，是三个协议里最忠实的通道。

## B23 文本级校验判据（EV14 / EV15）与漂移告警（2026-11-05 标定）

### 起因：判据在 24 小时内翻转

| 时间 | responses 参数校验 | messages 参数校验 |
|---|---|---|
| 11-04 白天 | ❌ 0/5（全 200） | ✅ 16/16 |
| 11-05 10:42 | ❌ 0/5 | ❌ 0/5 |
| 11-05 11:25 | ✅ **5/5** | ❌ 0/5 |

→ 同一条判据会在两个状态之间横跳，**任何把它当硬闸的设计都会周期性全站 503**。

### 新判据：官方「模型清单文案」vs 中转「包装前缀」

实测（官方/中转各 3 次 × 5 探针 = 15/15 稳定）：

| 探针 | 官方 | 中转 |
|---|---|---|
| 假模型 · responses | 400 `The supported API model names are deepseek-…` | 400 `Upstream request failed: Model is unavailable.` |
| 假模型 · messages（`/anthropic/v1/messages`） | 同上官方文案 | 同上包装 |
| 假模型 · chat | 同上官方文案 | 同上包装 |
| `max_tokens:0` · messages | 400 `Invalid max_tokens value, the valid range…` | 400 `Upstream request failed: [invalid_request_error] …` |
| `max_tokens:0` · chat | 同上 | 同上 |

**判据**：

```
EV14(proto)  ok = status===400 && /The supported API model names are/ && !/^\s*Upstream request failed[:：]/
EV15(proto)  ok = status===400 && /Invalid max_tokens value/            && !/^\s*Upstream request failed[:：]/
```

**为什么必须加"无包装前缀"**：当天实测中转对 `temperature:9` 会转发官方校验（返回官方文案），
但对假模型 / `max_tokens:0` 用自己的包装错误。只靠状态码或文案会误判。

### 打分（`validate`，每协议三态）

| status | 含义 |
|---|---|
| `pass` | 至少一条官方文案命中（且无包装） |
| `fail` | 探针都跑了，但全部被判负（或全部带包装前缀） |
| `unknown` | 一条都没跑（不能把"没测过"当成"不达标"） |

同时记录 `relayWrap`（该协议下带包装前缀的探针数）——这是**跨协议稳定的负向特征**。

### 漂移告警

`ocg audit-lane --write` 在写快照前与上一份对比，产出：

| 告警 | 触发条件 |
|---|---|
| `VALIDATOR_FLIP` | 任一协议 `validate.status` 变化（pass↔fail） |
| `MODEL_SET_DRIFT` | `/v1/models` 集合增删（记录新增/移除名单） |

写 `gate/logs/lane-alerts.jsonl`。首次运行（上一份快照没有对应字段）视为基线未知，不告警。

实测样例（11-05）：`VALIDATOR_FLIP messages: pass → fail（0/3, 中转包装 2）`、
`MODEL_SET_DRIFT 28→29 新增: hy4`。

### messages id 的第三种形态

`msg_` + 32hex（36 位），实测 5/5。已在 `shapeOf` 单列 `msg_hex`——
**行为不变**（仍归 third 拒绝），只是把信号从含糊的 `other` 变成可读名称。
## B24 逐响应骨架证据：server 头 + 顶层键顺序（2026-11-05 标定）

### 起因

`id` 形态只回答"这条响应是不是我方改写过的"，回答不了"这是谁在回"。
要判正，需要**每响应都有、不需要额外请求、且与业务流量完全同桶**的证据。

### 实测（真实上游，各 3/3 稳定）

| 观测点 | 官方 `api.deepseek.com` | 中转 `opencode.ai/zen/go` |
|---|---|---|
| 顶层键数 | **35** | **18**（带 `reasoning`）/ **17**（不带） |
| 键顺序 | serde 结构体声明顺序：`id,object,created_at,status,background,completed_at,…` | 另一套顺序：`id,object,created_at,status,error,incomplete_details,…` |
| `server` 头 | **`openresty`** | **`cloudflare`** |
| `cf-ray` / `x-zen-model` / `x-opencode-log-id` | 无 | 有 |
| `x-ds-trace-id` | 有 | 无 |

两者键集关系：**中转是官方的严格子集**（官方独有 17 键：`background`,`service_tier`,`text`,`truncation`,`top_logprobs`,…；中转独有 0 键）。

### 判据

```
keyOrderVerdict(顶层键序列):
  ① 键数 < 10 → unknown（少键不判）
  ② 键集覆盖率（能对到基线里的键）< 85% → 该项 0 分
  ③ LIS(按基线位置) / 键数 ≥ 95% → 该基线命中
  取官方/中转较高分；两边都像或都不像 → unknown
```

**只扫前 12 个顶层键**：判形只需前缀顺序，而 `MAX_BODY` 上限 24 MiB —— 全量字符扫描在最大包上约 60 ms，
会把「交付闸 p50 = 1 ms」直接吃掉。限 12 键 + 字符串整段跳过（`indexOf`）后，24 MB body 实测 **8 ms**。

**为什么用 LIS 而不是全等**：键集是**条件回显**的——请求里没有 `reasoning` 时上游就不返回该键。
第一次实现要求"长度全等"，结果真实流量（17 键）全被判 unknown（实测复现）。改成相对顺序 + 覆盖率后，
17/18 键中转 → `relay`，30/35 键官方 → `official`，乱序 35 键 → `unknown`（不误杀）。

### 与既有证据的关系

| 层 | 看什么 | 强度 |
|---|---|---|
| L0-2/L0-3（车道级） | 头：`x-ds-trace-id` / `cf-ray` 等 | 强负向，正向需 trace |
| 本判据（**逐响应**） | 头 `server` + 体 **键顺序** | 官方骨架 → `verified`；中转骨架/头 → `unverified`；都不像 → `unknown` |

落地在 `proof`（`x-gate-proof` 响应头 + `health.evidence.proof` + 台账 `proofEvidence`），**不参与放行/拒绝**，
只决定"这次交付被标成什么等级的官方痕迹"。

### 边界（必须承认）

- **可伪造**：中转只要按 serde 顺序重排 35 个字段就能过关。但那等于复刻官方信封（含 17 个它现在没有的字段），
  成本高；而且**一旦出现"中转头 + 官方骨架"，会触发 `ALERT_RELAY_MIMICS_OFFICIAL`**——把"伪装"本身变成信号。
- **不是判正**：在本机唯一可用车道（flash）上，它永远只能给出 `unverified`。这是诚实标注，不是故障。
- 官方改结构体顺序 → `OFFICIAL_TOP_KEY_ORDER` 必须重标定；漂移表现为 `keyOrder.unknown` 上升。

### 实测样本（生产重启后第一条）

```json
{"verified":0,"unverified":1,"keyOrder":{"official":0,"relay":1,"unknown":0},"server":{"relay":1},"relayMimicsOfficial":0}
```

## B25 体级判据：缓存块对齐 + 流式缓冲 + 缓存语义探针（2026-11-06 标定）

### 起因

B24 的骨架证据回答「信封是谁写的」，回答不了「后端有没有前缀缓存」。
而 cf-ray 这类头部判据在本车道**恒判 unverified**（8182/8182），没有区分力。
所以这一层只看**响应体里的缓存账本**。

### 实测（真实上游，2026-11-06）

| 观测点 | 结果 | 意义 |
|---|---|---|
| resp_uuid4 内部 32 hex 的 UUID4 位模式 | **70/70**；历史台账 **8182/8182** | 位模式校验误拒风险 **0.00%**，可安全作事前判据 |
| cached_tokens % 128 | **70/70 = 0** | 取值全集 {0,128,256,384,512,640,6912} |
| 非整倍数 input 的命中量 | 283→256、455→384、710→640 | **按 128 向下取整**，不是全量命中 |
| 缓存作用域 | 换 x-opencode-session 分布不变（B1/B2/B3 三组） | **全局前缀缓存**，不是 session 隔离 |
| 短 prompt（input < 128） | cached 恒 0 | 该区间**无区分力**（0 天然符合 %128） |
| 流式 vs 非流式 | 两边都恒为 128 倍数 | 判据与协议无关 |

### 判据

    L2（逐响应，非流式 + L3 开启时的流式）：
      cached_tokens > 0 && cached_tokens % 128 != 0  → cacheBlockMisaligned
      （默认 label：只记录；GATE_CACHE_BLOCK_ALIGN=require 才升 hard）

    L4（周期探针，补 L2 的「无缓存实现」盲区）：
      同一长前缀（>200 token）连发 2 次，取 max(cached)
      max == 0        → no_cache_impl
      max % 128 != 0  → block_misaligned
      否则            → ok

### 为什么 128 有意义

DeepSeek infra 的 cache block = 128；**vLLM 默认 block_size=16、SGLang 默认 1**。
所以「默认配置的同权重自部署」在这一项上必然对不上 —— 这是本判据唯一的真实鉴别力来源。
刻意把块大小配成 128 的自部署，与官方**不可区分**（诚实边界）。

### 与既有证据的关系

| 层 | 看什么 | 能挡 |
|---|---|---|
| L1（Q74-Q79） | id 位模式 | 异模型、非 UUID4 形态（**可被 2 字符伪造绕过**） |
| **L2/L4（本节）** | **缓存账本** | **默认配置的自部署（vLLM/SGLang）** |
| B24 | 信封骨架 | 中转 vs 官方格式（本车道恒 unverified） |
| canary EV10/EV13 | 分词一致性 | 模型族（DS vs 非 DS） |

### 边界（必须承认）

- **cached = 0 不是证据**：不做缓存的实现与「prompt 太短」都会给 0 ⇒ 必须靠 L4 的重复前缀探针
- **input_tokens 不能作 tokenizer 指纹**：同一 prompt flash 计 53、pro 计 106，usage 是网关按倍率估算的
- **抢跑不成立**：探针 1873ms > 业务首字节 1657ms（窗口 −216ms），所以 L3 只能「缓冲后判定」
- **流式判定必然付出延迟**：cached_tokens 在流的最后一个事件里，L3 缓冲把首字节从 1.6s 推到 1.9s

### 当前生产值（2026-11-06 首次采样）

    {"cached":128,"input":220,"runs":2,"ms":410,"block":128,"policy":"label","aligned":1,"misaligned":0}
