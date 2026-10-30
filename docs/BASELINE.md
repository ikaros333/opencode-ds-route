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
| B14 | 已**停用**的探针（2026-10-30 证伪） | `input:[]` 从 10-29 的 400 稳定原文退化为 **400/503 抖动（3:3）**；`reasoning.effort:"bogus"` 从 200 忽略变为偶发 400 `[InvalidParameter]` 透传（池级抖动）。两者**永久禁止进入预检与交付闸**，只可作告警信号 |
| B13 | 每响应指纹（**交付闸，2026-10-29**） | 非流式 `responses` 交付前校验 6 项结构事实：必需字段全在且无未知字段（15+3 口径，见 B13 细则）、`usage` 七键、`total=input+output`、`output item id` 形如 `rs_/msg_/fc_`+32hex、`incomplete` 必有 `reason`、`content` 元素键 ⊆ `{annotations,logprobs,text,type}`；请求带 `reasoning` 时响应必须回显 `reasoning`。流式校验事件家族（`created/in_progress/output_item.added/output_item.done` 且终止事件 ∈ `{completed,incomplete}`）+ `sequence_number` 单调。**实测 flash 车道 10/10 全绿**。策略 `GATE_FP_POLICY=retry|block|warn`（默认 retry） |
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
