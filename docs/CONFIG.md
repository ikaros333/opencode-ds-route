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
| `gate_proto_blocked` | 协议被 `GATE_BLOCK_PROTOS` 封禁（默认 `chat`） | 正常行为 |
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
| `GATE_CHAIN` | `deepseek-flash,deepseek-v4.1-flash` | **必须是 `deepseek-` 前缀，否则拒绝启动** |
| `GATE_MAX_ATTEMPTS` | 4 | 换道上限 |
| `GATE_BACKOFF_MS` | 200 | 换道退避 |
| `GATE_HEDGE` | 1 | 对冲开关（预检通过后不再触发） |
| `GATE_BLOCK_PROTOS` | 空 | 协议级封禁，推荐 `chat` |

### 预检（决定能否交付）

| 变量 | 默认 | 说明 |
|---|---|---|
| `GATE_PRECHECK` | 1 | `0` = 全断（没有判据就不交付） |
| `GATE_PRECHECK_TTL_MS` | 90000 | 预检复用窗口（responses） |
| `GATE_PRECHECK_TTL_MS_MESSAGES` | 90000 | messages 窗口 |
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
| `GATE_TOTAL_BUDGET_MS` | 120000 | 单请求总预算（= 车道数 × 单次超时，保证每条车道至少一次完整机会） |
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
