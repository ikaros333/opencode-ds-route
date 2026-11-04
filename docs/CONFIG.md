# CONFIG — 配置、端点与排障

面向使用者的配置手册：怎么起、每个环境变量做什么、503 时按 `error.type` 怎么定位。
判据的原理与观测记录见 [BASELINE.md](BASELINE.md)，安全边界见 [README](../README.md)。

## 一、30 秒上手

```powershell
# 1) 启动（key 从 User 环境变量读，不落盘）
node bin\ocg.mjs start

# 2) 自查
node bin\ocg.mjs doctor

# 3) dsh 侧：provider 指到 127.0.0.1:8787（见 DSH.md）
```

## 二、端点

| 端点 | 用途 |
|---|---|
| `GET /gate/health` | 判活 + 口径 + 启动自检 + 最近一次预检 |
| `GET /gate/metrics` | 计数器（`precheckNotPass` / `rejectedThirdShape` / `pass` …） |
| `GET /gate/proof` | 周期探针结论与信任判定 |
| `GET /gate/alerts` | 最近失败摘要（`recentFailures`，含预检 detail） |
| `GET /gate/latency` | p50 / p90 / p95 / p99 |
| `GET /gate/matrix` | 每条车道 × 每个协议的探测结论 |
| `POST /v1/responses`、`/v1/messages`、`/v1/chat/completions` | 被代理的三个协议 |

其余路径一律 `404 gate_unknown_path`；`/gate/*` 只接受 GET。

## 三、503 怎么查

先跑三条：

```powershell
curl.exe -sS http://127.0.0.1:8787/gate/health
curl.exe -sS http://127.0.0.1:8787/gate/alerts
curl.exe -sS http://127.0.0.1:8787/gate/metrics
```

`/gate/alerts` 的 `kind` 取值：

| `kind` | 含义 |
|---|---|
| `client` | 客户端问题：`gate_unknown_path`(404) / `gate_bad_body`(400) / `gate_body_too_large`(413) |
| `policy` | 被配置封禁：`gate_proto_blocked`(503) |
| `route` | 拿不到官方路由：`gate_precheck_not_pass` / `gate_precheck_failed` / `gate_no_official_route` |
| `upstream-4xx` | 上游 4xx 透传：`upstream_error` |
| `rate-limit` | 上游 429：`gate_upstream_rate_limited` |

按 `error.type` 处置：

| `error.type` | 含义 | 处置 |
|---|---|---|
| `gate_no_official_route` | 没拿到官方证据，或全部车道被拒 | 看 `error.precheck_verdict`，对照下表 |
| `gate_precheck_not_pass` | 预检未通过（最常见的 503） | 同上 |
| `gate_precheck_failed` | 预检未通过且 `GATE_PROOF_MODE=enforce` | 同上 |
| `gate_proto_blocked` | 协议被策略封禁（默认 `chat` + `messages`） | 正常行为；`error.available` 里列出可用端点 |
| `gate_structure_bad` | 非流式 `responses` 的响应没有正文（只有思考/空内容），且不是工具调用 | 上游把答案写进了 reasoning；直接重试通常可恢复；`error.truncated=true` 表示被 `max_output_tokens` 截断 |
| `gate_unknown_path` | 路径不在白名单 | 检查客户端端点；`messages` 的 baseURL **不带** `/v1` |
| `gate_bad_body` / `gate_body_too_large` | 请求体非 JSON / 超 16 MB | 客户端问题 |
| `gate_upstream_rate_limited` | 上游 429 且 `Retry-After` 过长 | 等，或检查配额 |
| `gate_method_not_allowed` | 方法与端点不符 | 客户端问题 |
| `gate_http_parse_error` | 上游响应无法解析 | 看台账 `HTTP_PARSE_ERROR` 行 |
| `gate_handler_error` | 门控内部异常（已被兜住） | 看 `HANDLER_ERROR`；出现即 bug，欢迎报 issue |

预检未通过时，`/gate/alerts` 的 `recentFailures[].precheck` 会给出判据摘要，例如：

```json
{"kind":"route","type":"gate_precheck_not_pass","status":503,"reqId":"f66fc092","proto":"messages",
 "elapsedMs":265,"precheck":"msgfp:fail(fingerprint=200,200,200,200,200,200,200,200,200 ✗)"}
```

| `precheck` 内容 | 判定 | 处置 |
|---|---|---|
| `e1:format(...)` 且原文含 `request_id: <uuid4>` | 上游改了 e1 措辞 | 更新 `gate/baseline.mjs` 里的期望正则 |
| `e1:format(...)` 但 `request_id` 缺失或非 UUID4 | 有人仿了文案没仿 uuid | 保持 503，这是正确行为 |
| `e1:net` | 上游 5xx / 连接失败 | 等恢复；503 会带 `retry-after` |
| `timeout` | 预检超时 | 上游拥塞，等恢复 |
| `msgfp:fail(...)` | messages 指纹不符（上游改校验，或真第三方） | 对照官方直连重跑，确认后更新 `MSG_FINGERPRINT` |
| `msgfp:net(...)` | 多数探针连不上（上游抖动） | 等恢复；结论会被 TTL 缓存，可能放大成约 30 秒的 503 窗口 |
| `unsupported` | 该协议无判据（`chat`） | 正常；该协议本就不可交付 |

被形态判定拒绝时，台账里是 `REJECT_SHAPE_THIRD`（id 为 `HEX32` / `chatcmpl` / `gw-` / 纯数字）
或 `REJECT_SHAPE_UNKNOWN`（无 id 或不可交付形态）。这说明这次确实被路由到了非官方池，
门控按设计拒绝；持续出现才是问题。

## 四、环境变量

优先级：已存在的环境变量 > 仓库根 `.env`（不读当前工作目录的 `.env`）。
模板见 [.env.example](../.env.example)。

### 监听与上游

| 变量 | 默认 | 说明 |
|---|---|---|
| `GATE_PORT` | 8787 | 监听端口（只绑 `127.0.0.1`） |
| `GATE_HOST` | `opencode.ai` | 上游主机（唯一出网目标） |
| `GATE_HOST_PORT` | 443 | 上游端口 |
| `GATE_HOST_SCHEME` | `https` | 上游协议 |
| `GATE_SESSION` | 空 | 不设则读 `gate/logs/session.txt`，都没有就生成并写回。**决定 prompt cache 亲和，别乱换** |

### 路由

| 变量 | 默认 | 说明 |
|---|---|---|
| `GATE_CHAIN` | `deepseek-v4.1-flash` | **必须是 `deepseek-` 前缀，否则拒绝启动**；2026-10-27 起 `deepseek-flash` 已被上游下线（410） |
| `GATE_MAX_ATTEMPTS` | 4 | 换道上限 |
| `GATE_BACKOFF_MS` | 200 | 换道退避 |
| `GATE_HEDGE` | 1 | 对冲开关（预检通过后不再触发） |
| `GATE_BLOCK_PROTOS` | `chat` | 追加封禁的协议列表（逗号分隔） |
| `GATE_IMPL_VECTOR_MS` | 300000 | 实现指纹向量观测间隔（仅告警，不参与放行）；`0` = 关闭 |
| `GATE_ALLOW_MESSAGES` | 未设置 | **`1` 才解封 `messages`**。上游 messages 侧已混入非 UUID4 id 池，解封前必须先重新标定 `MSG_FINGERPRINT` |

### 预检（决定能否交付）

| 变量 | 默认 | 说明 |
|---|---|---|
| `GATE_PRECHECK` | 1 | `0` = 全断（没有判据就不交付） |
| `GATE_PRECHECK_TTL_MS` | 15000 | 预检复用窗口（responses）。2026-10-29 由 90000 收紧：池切换是分钟级，90s 窗口会让预检结论与交付时刻错位 |
| `GATE_PRECHECK_TTL_MS_MESSAGES` | 90000 | messages 窗口（协议已封禁） |
| `GATE_DRAIN_MAX_MS` | 15000 | `POST /gate/admin/drain` 等待在途请求收尾的上限（ms）；空闲时立即完成，所以调大几乎不增加重启耗时 |
| `GATE_OBS_TOKEN` | 空（关闭） | `/gate/*` 观测端点的独立鉴权 token；设了以后必须带 `x-gate-token`。与 `GATE_TOKEN` 解耦 |
| `GATE_FP_POLICY` | retry | 每响应指纹策略：`retry` 不匹配就丢弃重发，`block` 直接 503 `gate_response_fingerprint`，`warn` 只记录 |
| `GATE_FP_RETRIES` | 2 | `retry` 模式下的最大重发次数 |
| `GATE_PRECHECK_TTL_MS_CHAT` | 15000 | chat 窗口（已封禁，实际不起作用） |
| `GATE_PRECHECK_WAIT_MS` | 未设（自动派生） | 一般不要设；设了也必须 ≥ 探针上限，否则被强制抬升并记 `CONFIG_CLAMPED` |
| `GATE_PRECHECK_WAIT_SLACK_MS` | 5000 | 派生时在探针上限上留的余量 |
| `GATE_PRECHECK_CONFIRM` | 1 | `fail` 后的确认重测次数 |
| `GATE_PRECHECK_CONFIRM_MS` | 250 | 重测间隔 |
| `GATE_PROBE_DEADLINE_MS` | 未设（自适应） | 仅用于固定探针上限 |
| `GATE_PROBE_DEADLINE_K` | 3 | 自适应系数：`deadline = clamp(K×EWMA, MIN, MAX)` |
| `GATE_PROBE_DEADLINE_MIN` | 5000 | 下限 |
| `GATE_PROBE_DEADLINE_MAX` | 45000 | 上限 |
| `GATE_PROOF_REFRESH_MS` | 25000 | 后台保活间隔（把探针移出请求关键路径）；`0` = 关闭 |
| `GATE_RESP_SHAPE_STRICT` | 严格 | `resp_` 后缀必须是 UUID4 位模式（第13位=4、第17位∈89ab），否则判第三方拒绝；只有显式 `0` 才回退到「resp_ 一律中性」的旧行为（应急用） |

后台保活让正常请求只付生成延迟：窗口内有过 `pass` 就直接复用，最近一次实测是 `fail` 就立即拒绝，
两者都没有才在现场跑探针。延迟参数只影响可用性，不参与身份判定——超时只会把「未知」变成拒绝，
不会把第三方判成官方。

### proof（不参与授权，只影响车道过滤与告警）

| 变量 | 默认 | 说明 |
|---|---|---|
| `GATE_PROOF_FILE` | `gate/logs/official-proof.json` | 探针写入位置 |
| `GATE_PROOF_MODE` | `monitor` | 对授权无影响 |
| `GATE_PROOF_MAX_AGE_MS` | 600000 | 过期即降信任 |
| `GATE_PROOF_STRICT_AGE_MS` | 120000 | 收紧龄期 |
| `GATE_PROOF_RELOAD_MS` | 5000 | 重读磁盘间隔 |
| `GATE_OVERRIDE_FRESH_MS` | 240000 | `0` = 禁止 proof 覆盖预检失败 |

### 预算与超时

| 变量 | 默认 | 说明 |
|---|---|---|
| `GATE_TOTAL_BUDGET_MS` | 90000 | 单请求总预算（首选车道 60s + 后备 30s；见下方说明） |
| `GATE_UPSTREAM_TIMEOUT_MS` | 60000 | 上游单次超时 |
| `GATE_BODY_IDLE_TIMEOUT_MS` | 120000 | 流空闲超时 |
| `GATE_MAX_BODY` | 16 MB | 请求体上限 |
| `GATE_MAX_CONC` | 6 | 上游并发槽 |
| `GATE_UPSTREAM_FAST_FAIL_LANES` | 2 | 全车道连不上时快速收敛 |
| `GATE_LANE_RETRY` / `GATE_LANE_RETRY_MS` | 2 / 300 | 同车道重试 |
| `GATE_RATE_LIMIT_MAX_WAIT_MS` | 5000 | 429 等待上限 |
| `GATE_PROBE` / `GATE_REFRESH_MS` / `GATE_PROBE_TTL_MS` / `GATE_PROBE_TIMEOUT_MS` | 1 / 300000 / 120000 / 5000 | 车道探针 |
| `GATE_SKIP_PROBE_TTL_MS` | 30000 | 预检刚过时跳过探针的窗口 |

### 日志与状态

| 变量 | 默认 | 说明 |
|---|---|---|
| `GATE_LOG_FILE` | `gate/logs/gate.jsonl` | 台账（不记正文，只记结构化字段） |
| `GATE_LOG_CAP` / `GATE_LOG_KEEP` | 5 MB / 5 | 轮转 |
| `GATE_SNAPSHOT` | `gate/logs/matrix.json` | 矩阵快照 |
| `GATE_LAT_WINDOW` / `GATE_FAIL_WINDOW` | 200 / 20 | 延迟窗口 / 失败缓冲 |
| `GATE_STARTUP_SELFTEST` | 1 | 启动时跑一次自检 |
| `GATE_TRACE` | 空 | `1` = 把每次出网目标打到 stderr（只有 host:port + path） |

### 仅测试用（生产环境必须留空）

| 变量 | 作用 |
|---|---|
| `GATE_FORCE_THIRD` | 强制判第三方（预检一起失败） |
| `GATE_FAULT_MAIN_THIRD` | 只污染主请求结论，不动预检 |
| `GATE_FAULT_PRECHECK` | `always` / `jitter`，模拟预检确定性失败或抖动 |
| `GATE_PROBE_P1` | 打开已退役的精度探针（会烧 token） |

## 五、关键不变量

1. 主请求**永不**发往 `deepseek-v4-flash` / `deepseek-flash-1017`（`FORBIDDEN`）；
2. `GATE_CHAIN` 必须全部 `deepseek-` 前缀，否则拒绝启动；
3. 预检非 `pass` → 503，且不消耗上游配额；
4. 形态命中强反面清单 → 拒绝；`official` 没有特权；
5. 不存在「无证明也交付」的路径；
6. 单请求最多 `GATE_MAX_CONC` 个上游并发，受 `GATE_TOTAL_BUDGET_MS` 约束；
7. 台账不记请求/响应正文，只记结构化字段。

预算不变式（`/gate/health` 的 `budgetInvariantOk` 可直接核对）：

```text
precheckWaitMs() + min(MIN_UPSTREAM_BUDGET_MS, TOTAL_BUDGET_MS/2) ≤ TOTAL_BUDGET_MS
```


**关于总预算（2026-10-26 标定）**：大包流式请求（≈2.6MB / 39 tools）首字节
p50 3.9s / p90 36.4s / p99 54.3s，所以单次上限保持 60s；而总预算若等于单次上限，
一次挂死就会烧光预算、第二条车道永远轮不到，因此默认取 120s（2 车道 × 60s）。
另外「吃满单次上限的慢挂」不再重试同车道，直接换道（台账记 `LANE_SLOW_HANG`）。
改 `GATE_CHAIN` 增加车道时，请同步放大该值。
## 六、回滚

```powershell
git log --oneline -10
git checkout <上一个可用版本> -- gate\oc-gate.mjs gate\verify-patch.mjs
# 然后重启门控（结束进程，等监护拉起；或删 stop.flag 后手动启动）
```

急用可以直接退回直连：把客户端里的 provider 改回 `https://opencode.ai/zen/go`。

## 七、门控自身故障

| 现象 | 处置 |
|---|---|
| 8787 无监听 | `Start-ScheduledTask 'OpenCodeDS Route Gate'`（若装了计划任务） |
| `health` 打不开但有端口 | 端口被别的程序占用：`Get-NetTCPConnection -LocalPort 8787` 查 PID |
| `crashCount` 增长 | 看台账 `UNCAUGHT_EXCEPTION` / `UNHANDLED_REJECTION` 行 |
| `ok=false` 且 `startupSelfTest != pass` | 上游不可达或判据漂移，按第三节处理 |
| 改了代码但行为没变 | `doctor` 看「门控归属」：`health.root` 指向另一个目录说明 8787 上跑的是**另一份安装**（同名计划任务被覆盖过） |
| 第二个实例起来就没了、无日志 | 单实例锁：同端口第二个监护 exit 3，提示里带占用者 pid/root；锁文件 `supervise-<port>.lock`。要并存就换端口（`--port 8888`） |
| 监护反复拉起、门控秒退 | 端口被占用：门控 exit 4 并打印占用者（会探测对端 `/gate/health`）。看 `supervise` 的 stderr；旧版会 15s 退避无限重启，新版直接停 |

## 证据链（2026-11-02）

正向证据链（EV1–EV9）用于回答「我连的是不是官方 API 端点」，与「判负」互补。

| 变量 | 默认 | 说明 |
|---|---|---|
| `GATE_EVIDENCE_POLICY` | `label` | `off` / `label`（只记录+漂移告警）/ `require`（未达成则 503） |
| `GATE_EVIDENCE_EXPECT` | `any` | 本车道声明期望；只有设 `official` 时 `require` 才生效（否则等于自断服务） |
| `GATE_EVIDENCE_FILE` | `gate/logs/lane-evidence.json` | 证据快照路径 |
| `GATE_EVIDENCE_MAX_AGE_MS` | `43200000`（12h） | 快照过期判定；过期在 `require` 下 fail-closed |
| `GATE_EVIDENCE_KEY_ENV` | 空 | 强制指定探针使用的 key 环境变量（默认按 host 自动选择） |

生成/查看证据：

```bash
node bin/ocg.mjs audit-lane            # 只跑零成本探针（EV1–EV8）
node bin/ocg.mjs audit-lane --gen      # 追加能力探针 EV9（会真实生成）
node bin/ocg.mjs audit-lane --write    # 写快照供门控读取
```

判定口径：

- **L1 端点身份（可证）**：EV1 余额端点 / EV2 FIM beta 引导 / EV3 温度范围 / EV4 top_p 范围 / EV5 证书 / EV6 ALPN。≥5/6 → `official`；≤2 → `non-official`；其余 `unknown`。
- **L2 实现身份（高置信）**：EV7 响应形态（35 字段 + 裸 UUID4 + 5 键 usage）/ EV8 Rust serde 文案 / EV9 能力探针。
- **L3 模型身份**：永远 `unproven`（同权重自部署不可区分）。

## 模型族证据（2026-11-02）

正向证据链的第三层：判断「服务你的是不是 DeepSeek 模型、且请求是否到达官方校验器」。
与端点证据（EV1–EV6）互补——端点证明"连的是谁"，模型族证明"是不是 DS、经不经官方"。

| 变量 | 默认 | 说明 |
|---|---|---|
| `GATE_MODEL_EVIDENCE_POLICY` | `label` | `label` 只记录；`require` = `model.family` 必须为 `deepseek-official`，否则 503 `gate_modelfamily_unmet` |
| `GATE_EVIDENCE_FILE` | `gate/logs/lane-evidence.json` | 证据快照路径（CLI `--write` 也写这里） |
| `GATE_EVIDENCE_MAX_AGE_MS` | `43200000`（12h） | 快照过期判定；过期在 `require` 下 fail-closed |
| `GATE_EVIDENCE_KEY_ENV` | 空 | 强制指定探针用的 key 环境变量（默认按 host 自动选：`*.deepseek.com` → `DEEPSEEK_API_KEY`，其它 → `OPENCODE_GO_API_KEY`） |

### 三档判定

| family | 条件 | 含义 |
|---|---|---|
| `deepseek-official` | EV10 分词 10/10 **且** EV11 官方校验器 3/3 | 是 DS 模型，且请求到达官方实现 |
| `deepseek-thirdparty` | EV10 通过、EV11 不通过 | 是 DS 模型，但由第三方/自部署提供 |
| `mismatch` | EV10 命中 ≤4/10 | 模型被换成非 DS 家族 |
| `unknown` | 探针失败 / 快照缺失 | 不下结论 |

`model.weights` 永远为 `unproven`——权重托管方不可证。

### 典型用法

```bash
# 只观测（默认，零风险）
node bin/ocg.mjs audit-lane --write      # 采集证据写快照
GATE_MODEL_EVIDENCE_POLICY=label

# 只放行官方提供（会让第三方通道 503）
GATE_MODEL_EVIDENCE_POLICY=require
```

## 请求体上限与大 body 观测（2026-11-03）

| 变量 | 默认 | 说明 |
|---|---|---|
| `GATE_MAX_BODY` | 16 MiB | 超过直接 413（fail-closed），报错体带 `actual_bytes`，响应头带 `x-gate-fatal: 1`（提示重试无意义） |
| `GATE_BIG_BODY_BYTES` | 12 MiB | 超过即打 `x-gate-big-body: 1` + 台账 `BIG_BODY`，用于提前发现上下文膨胀 |
| `GATE_UPSTREAM_TIMEOUT_MS` | 60 s | 单次上游超时 |
| `GATE_TOTAL_BUDGET_MS` | 90 s | 单请求总预算 |
| `GATE_ATTEMPT_HARD_CAP_MS` | 180 s | 单次尝试硬上限，**必须 > 上游超时**，否则会先被它掐断 |

### 改动上限时必须四个一起动

```powershell
setx GATE_MAX_BODY 25165824            # 24 MiB
setx GATE_UPSTREAM_TIMEOUT_MS 120000   # 120 s
setx GATE_TOTAL_BUDGET_MS 150000       # 150 s
setx GATE_ATTEMPT_HARD_CAP_MS 180000   # 保持 > 上游超时
```

> 注意：**计划任务/监护进程启动的门控不会继承当前终端的环境变量**。改完 `setx` 后需要重启监护进程（`ocg stop` → 重新拉起 supervise），否则 health 里 `bodyLimit.maxBodyBytes` 仍是旧值。

## 端点指纹与 assurance 闸（2026-11-04）

三档证据体系：**L0 端点指纹**（零成本判负）→ **L1/L2 端点与实现身份** → **MX messages 协议**（唯一可判正）。

| 变量 | 默认 | 说明 |
|---|---|---|
| `GATE_ASSURANCE` | `label` | `off` / `label`（只记录）/ `probe`（需校验器可达）/ `strict`（需 L0 全过 + 逐响应官方痕迹） |
| `GATE_L0_POLICY` | `label` | `label` 只标注；`reject` 则 L0 指纹不全即 503 `gate_assurance_unmet` |
| `GATE_ALLOW_MESSAGES` | 关闭 | 设为 `1` 才允许客户端使用 `/v1/messages` |

### L0 端点指纹（5 条，零 token，秒级）

| ID | 判据 | 官方 | 中转/自部署 |
|---|---|---|---|
| L0-1 | `GET /v1/models` 的 `owned_by` 全为 `deepseek` 且条目 ≤5 | ✅ | ❌ |
| L0-2 | 响应头含 `x-ds-trace-id` | ✅ | ❌ |
| L0-3 | 无 `cf-ray` / `x-zen-model` / `x-opencode-log-id` | ✅ | ❌ |
| L0-4 | 无认证 401 文案含 `Authentication Fails (governor)` | ✅ | ❌ |
| L0-5 | 试跑 `glm-5.2` 必须 400（能跑通=转售池） | ✅ | ❌ |

### MX messages 协议判据（6 条）

| ID | 判据 | 官方 | 中转 |
|---|---|---|---|
| M1 | 成功响应 `id` 为 UUID4 | ✅ | 53~62 hex |
| M2 | `usage` 无 `cost`/`opencode` | ✅ | ❌ |
| M3 | `usage` 含 `service_tier` | ✅ | ❌ |
| M4 | 错误无 `(request id: 2026…)` 包装 | ✅ | ❌ |
| M5 | 错误无 `Upstream request failed:` 前缀 | ✅ | ❌ |
| M6 | 错误含官方范围文案 + UUID4 `request_id` | ✅ | ✅（=校验器可达） |

> messages 路径因上游而异：官方是 `/anthropic/v1/messages`，中转是 `/v1/messages`，探针按 host 自动选择。

### 逐响应官方痕迹

每个成功响应都打一个响应头：

```
x-gate-proof: verified    ← 上游带 x-ds-trace-id 且无第三方包装头
x-gate-proof: unverified  ← 出现 cf-ray / x-zen-model / x-opencode-log-id
x-gate-proof: unknown     ← 两者都没有
```

### 常见组合

```bash
# 中转通道 + 需要"校验器可达"才放行
GATE_ALLOW_MESSAGES=1
GATE_ASSURANCE=probe

# 直连官方
GATE_ASSURANCE=strict
GATE_L0_POLICY=reject
```