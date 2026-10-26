# DSH 接入

dsh 通过 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 声明 provider。
**这个文件是「补丁层数组」**：顶层是一组 `- id: <插件 id>` 条目，不是普通配置对象。
写错结构 dsh 不会报错，只会静默不生效——所以照抄下面已验证过的形状。

## 一键打印片段

```powershell
node bin\ocg.mjs setup dsh
```

输出是要**插进** `llm-pi-ai` 条目的 `config.providers:` 下面的一段（只贴 provider 键，不要连 `- id:` 一起贴）：

```yaml
      # 位置：- id: llm-pi-ai → config: → providers: 下面
      ocg-gated:
        displayName: "OpenCode Go · Responses（经门控）"
        apiKeyEnv: OCG_PLACEHOLDER_KEY
        api: openai-responses
        baseURL: http://127.0.0.1:8787/v1
        headers:                       # 仅启用 GATE_TOKEN 时需要
          x-gate-token: "<你的 token>"
        models:
          - id: deepseek-flash
      ocg-gated-msg:
        displayName: "OpenCode Go · Messages（经门控）"
        apiKeyEnv: OCG_PLACEHOLDER_KEY
        api: anthropic-messages
        baseURL: http://127.0.0.1:8787
        models:
          - id: deepseek-flash
      # 原有 provider（例如直连的 opencode-go）保持在同一个 providers 下，不要删
```

## ⚠ 不要新加第二个 `- id: llm-pi-ai` 条目

2026-10-23 实测（`dsh --dump-config`，改前备份、改后哈希还原）：

> 在同一个补丁层里再写一个 `- id: llm-pi-ai`，后者的 `config.providers` 会**整体替换**
> 前一层的 providers 字典——原有的 `opencode-go`、`ocg-gated` 全部消失，只剩新条目里的键。

也就是说"追加一个条目"会把你自己的直连路由清空。`setup dsh --apply` 因此做的是**文本插入**
（定位到 `- id: llm-pi-ai` 下的 `providers:`，把新键插进去），并在写盘前自检：
条目数不变、`ocg-gated`/`ocg-gated-msg` 各出现一次。写前会备份成 `.bak-<时间戳>`。

结构不符合预期时它拒绝写入，只打印片段让你手工合并。

## 三个必踩的坑

1. **`anthropic-messages` 的 baseURL 不带 `/v1`**，dsh 自己拼 `/v1/messages`；
2. **改完必须重启 dsh 进程**（`cordis.patch.yml` 只在启动时加载，刷新页面不够）；
3. **`apiKeyEnv` 用占位变量 `OCG_PLACEHOLDER_KEY`**（值随便填）：门控只用自己的 `OPENCODE_GO_API_KEY`，客户端带来的 key 会被覆盖。这样真 key 不经过 `127.0.0.1`。**设完变量必须重启 dsh**，否则报 `no credential` 且模型消失。

## 怎么确认真的生效

```powershell
dsh --profile web --dump-config | Select-String ocg-gated
```

能打出 `ocg-gated` 与 `ocg-gated-msg` 两个 provider 就说明补丁层被正确解析；
再在模型选择器里选「OpenCode Go · Responses（经门控）」发一条消息即可。

## 改完怎么重启

`cordis.patch.yml` 只在 dsh 启动时加载。操作顺序：

1. 关闭正在运行的 dsh（关窗口；或任务管理器里结束 dsh / 对应的 node 进程）；
2. 按你平时的方式重新启动（`dsh web`、桌面快捷方式或开始菜单）；
3. 等界面起来后，`doctor` 的「dsh 配置」应显示已指向 `127.0.0.1:8787`。

## 打开配置文件

```powershell
notepad "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml"
# 或
code "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml"
```

改之前建议先复制一份：`Copy-Item ... ...bak`（`setup dsh --apply` 会自动备份）。

## 兼容性

- 需要 dsh ≥ `0.2.0-rc.2`（本仓库在 `0.2.1-rc.2` 的 web profile / `llm-pi-ai` 插件上验证）；
  0.1.x 没有这一层 provider 配置，写了也不会生效。
- 其他版本若改了 provider 配置结构，`setup dsh --apply` 会拒绝写入并要求手工合并，不会写坏文件。

## 门控做了哪些兼容处理

| 问题 | 门控的处理 |
|---|---|
| dsh 把 MCP 工具 schema 转成 messages 时丢 `$defs`，只留悬空 `$ref` → 必然 400 | `normalizeToolSchemas` 只摘掉确实无指向的 `$ref` 并保留 `description`（实测修正 493 处后 200） |
| 三条协议判据强度不等价 | `responses`（e1 + id 形态）最强；`messages`（9 项状态码指纹）次之；`chat` 无判据，默认封禁 |
| `x-opencode-endpoint-id` 实测恒为 `undefined` | 不作为判据，避免误判 |

## 常见错误对照

| 症状 | 原因 | 处理 |
|---|---|---|
| 客户端 `Connection error` | 门控没在跑 | `node bin\ocg.mjs doctor` |
| provider 列表里看不到 `ocg-gated` | 补丁结构写错（用了 `llm:` 而不是数组条目） | 跑 `node bin\ocg.mjs setup dsh` 对照形状 |
| 原有 provider 消失 | 新加了第二个 `- id: llm-pi-ai` 条目 | 用备份恢复，改成插入 `providers` 下 |
| 401 `gate_unauthorized` | 启用了 `GATE_TOKEN` 但 provider 没带 `x-gate-token` | 加 `headers.x-gate-token`，或重装时用 `-NoToken` |
| 全部 503 `gate_precheck_not_pass` | 上游判据变化或上游本身故障 | `node bin\ocg.mjs diag`，再对照 `BASELINE.md` |
| 首字节很慢 | 预检在关键路径上；`GATE_PROOF_REFRESH_MS` 被设为 0 | 恢复后台保活（默认 25000ms） |
| 装了反而更慢 | 多个客户端共用同一个 `STABLE_SESSION`，prompt cache 亲和互相污染 | 建议只给 dsh 用，或另起一个实例换端口 |
