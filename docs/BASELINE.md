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
| B3 | `responses` e1 探针 | 发一个缺 `input` 的 0-token 请求，官方返回 serde 层原话 + 内嵌 UUID4 `request_id` | 2026-10-23 | `baseline.mjs` 的 `E1_MSG` |
| B4 | `messages` 状态码指纹 | 9 项非法参数请求 → `400,400,400,400,400,400,422,422,422`（400=业务层，422=反序列化层） | 2026-10-19 | `baseline.mjs` 的 `MSG_FINGERPRINT` |
| B5 | `chat` 协议 | 无可用的零成本判据，默认封禁 | — | 保持封禁（`GATE_BLOCK_PROTOS=chat`） |
| B6 | 网关拦截话术 | `Upstream request failed` / `Endpoint is unavailable` / `Model is unavailable` → 归为 `gateway`，既不算官方也不算第三方 | 2026-10-19 | `baseline.mjs` 的 `GATEWAY_BLOCK` |
| B7 | id 形态不可控 | `resp_` 与 UUIDv4 由上游**双池随机**决定，同一 header 组合前后两次结果可不同；不存在"强制 UUIDv4"的旋钮 | 2026-10-23 | 不要试图"修"，这是上游行为 |
| B8 | 探针必须非法 | 只有"非法请求"能拿到可识别的错误；"合法请求"必须正常出词。因此中间层可用的分类器是「这个请求合法吗」，随机化探针参数/提频/加第二判据/加影子探针**全部无效** | 2026-10-23 | 已评估并否决，不要重做 |

## 上游变化时怎么判断是哪条断了

```powershell
node bin\ocg.mjs doctor          # 看 judgeAgeMs / lastJudgeOk
curl.exe -sS http://127.0.0.1:8787/gate/alerts
node probe\official-detect.mjs --lite    # 只跑 E 类，0 token
```

| 现象 | 最可能断的 | 下一步 |
|---|---|---|
| 全部 503，`e1:format` | B3 | 抓一次上游 400 的原文，对照 `E1_MSG` |
| 全部 503，`msgfp:fail 400×9` | B4 | 状态码序列变了，重新标定 9 项 |
| 部分交付，id 落 `other` | B1 | 把新形态加进 `shapeOf()` 并告警，观察一天 |
| 预检 pass 但交付 503 | B2 | 白名单与预检结论打架，先看 `/gate/metrics` 的 `rejectedThirdShape` |

## 改动纪律

1. 改任何常量 → 同步更新本表日期与 `baseline.mjs` 的 `OBSERVED_AT`；
2. 改判据属于 **minor** 版本变更，CHANGELOG 要单独置顶写清"可能影响交付率"；
3. 不改架构的前提下，先改常量；改架构要先写清为什么常量方案不成立。
