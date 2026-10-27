# 常见问题

先跑这两条，多数问题自己能看出来：

```powershell
node bin\ocg.mjs doctor    # 九项体检，每个 ❌ 后面都跟着下一步
node bin\ocg.mjs diag      # 脱敏诊断摘要，贴 issue 用
```

## 连不上 / 客户端报 Connection error

门控没在跑，或端口不是客户端指向的那个。

```powershell
node bin\ocg.mjs doctor
# 没跑就启动：npm run supervise（带监护）或 npm start（单进程）
```

## 全部 503

`error.type` 决定方向：

| `error.type` | 含义 | 处理 |
|---|---|---|
| `gate_precheck_not_pass` | 预检判不出官方 | 看 `/gate/alerts` 的 detail；对照 [BASELINE.md](BASELINE.md) |
| `gate_budget_exhausted` | 上游太慢，预算耗尽 | 看 `elapsed_ms`；上游抖动时重试 |
| `gate_no_official_route` | 没有可用车道 | 查 `GATE_CHAIN` 与上游状态 |
| `gate_upstream_rate_limited` | 上游 429 | 等 `Retry-After`，或换车道 |
| `gate_bad_content_type` | 请求没带 `content-type: application/json` | 客户端补上；这是挡浏览器跨域借道的，不是配置错 |
| `gate_bad_host` | Host 头不是 `127.0.0.1` / `localhost` | 用 `http://127.0.0.1:8787`，别用映射域名 |

**急用先退回直连**：删掉客户端里指向 `127.0.0.1:8787` 的 provider，改回
`https://opencode.ai/zen/go`。详细归因见 [CONFIG.md](CONFIG.md#三503-怎么查)。

## 401 gate_unauthorized

启用了 `GATE_TOKEN`，但客户端没带请求头。两种选择：

- 在客户端 provider 里加 `headers.x-gate-token: "<token>"`（dsh 配置见 [DSH.md](DSH.md)）；
- 或重装时用 `install.ps1 -NoToken`（不推荐：本机其它进程也能用你的 key 配额）。

## `messages` 协议 503 / 客户端提示协议被封禁

**这是预期行为，不是故障。** 2026-10-27 起 `messages`（Anthropic 风格）默认封禁，只保留 `responses`。

原因（实测，详见 [BASELINE.md](BASELINE.md) 的 B4-drift / B5b）：

- `messages` 响应 id 在同一小时内出现 `UUID4` / 13位时间戳+40hex / **32hex** 三种生成器，官方直连恒为 `UUID4`；
- 参数校验时有时无：`max_tokens=0` 有时 400 有时 **200**；`role:"wizard"` 有时 422 有时 **200**；
- 抓到 Go 实现参与：`json: cannot unmarshal string into Go struct field plain.max_tokens`（DeepSeek 官方是 Rust/serde）；
- 每条响应都被网关改写：`usage` 恒含 `cost`+`opencode`，恒缺官方的 `service_tier`。

处理：

1. **改用 `responses`**：baseURL 填 `http://127.0.0.1:8787/v1`，`api` 选 `openai-responses`（dsh 里就是 `ocg-gated` 那条）；
2. 想验证封禁是对的就解封一次：`GATE_ALLOW_MESSAGES=1`，连打 10 次 `/v1/messages`，台账会同时出现 `PASS` 与 `REJECT_SHAPE_UNKNOWN(idShape=other53)`；
3. 想长期恢复：先按 BASELINE.md 重新标定 `MSG_FINGERPRINT`，再设 `GATE_ALLOW_MESSAGES=1`。不重标定直接解封 = 时而 200 时而 503。

`error.type` 为 `gate_proto_blocked`，响应体里的 `error.blocked_protocols` / `error.available` 会列出当前可用的端点。

## `x-gate-trust` 只有 medium，能不能升到 strong

不能。`medium` 是 `opencode.ai/zen/go` 这条通道的物理上限：

- 官方直连具备的强证据（`UUID4` 直出 id、`UUID4` `request_id`、原样字段名、严格枚举校验、`service_tier`、真实 logprobs）**已被 OpenCode 网关全部替换或关闭**；
- 实测确认客户端也**没有**任何"要求官方后端"的开关：11 个 `x-opencode-*` 请求头、两套端点前缀、WebSocket 传输全部试过，上游形态零变化（详见 [BASELINE.md](BASELINE.md)）。

`strong` 只在"上游恢复官方直出形态"时才会出现（代码里保留该分支）。要现在就拿到强证据，只能直连 `api.deepseek.com`（本项目的默认路径不含它）。

## 装了反而更慢

多个客户端共用一个 `STABLE_SESSION`，prompt cache 亲和会互相污染。
建议只给 dsh 用，或另起一个实例换端口（`GATE_PORT=8788`）。

## 端口被占用

`doctor` 会显示 PID 和进程名。**本程序不会替你杀进程**：换 `GATE_PORT`，或你自己确认后结束它。

## doctor 说"该门控未暴露判据字段"

连到的是旧版本门控（没有 `judgeAgeMs` 等字段）。升级到本版本后重启即可。

## 计划任务起不来

按顺序看：

1. `schtasks /query /tn "OpenCodeDS Route Gate"` 是否有这个任务；
2. 任务动作里的 node 路径是否存在（重装会改写）；
3. `gate\logs\` 下有没有报错（`OPENCODE_GO_API_KEY 缺失` 最常见：`setx` 后要新开终端 / 重新登录）；
4. 仍不行就跑 `install.ps1 -WhatIf` 看它会做什么，再带 `-Force` 重装。
