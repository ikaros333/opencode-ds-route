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
