# 贡献指南

## 先看边界

- **平台**：只支持 Windows（Node ≥ 22）。Linux/macOS 的 PR 可以提，但不会作为支持承诺。
- **零依赖**：`gate/`、`probe/`、`bin/` 不允许引入第三方包。需要的能力先看 Node 内置模块。
- **语言**：代码注释与文档以中文为主，标识符与命令保持英文。
- **不改口径**：`README` 的"解决什么 / 不解决什么"是项目边界；想扩大边界请先开 issue 讨论。

## 仓库结构

```text
bin/        ocg.mjs（CLI）、ocg-supervise.mjs（监护）
gate/       oc-gate.mjs（门控本体）、baseline.mjs（判据基线，唯一来源）、
            verify-patch.mjs（源码断言）、test-*.mjs（12 套回归）
probe/      official-detect.mjs（0 token 官方性探针）
scripts/    install-service.ps1、install-probe-task.ps1、regress.ps1
docs/       运维手册 / 基线 / 审计 / FAQ / 免责声明 / DSH / 变更记录 / 发布清单
examples/   dsh provider 片段
install.ps1  uninstall.ps1  start.cmd
```

## 本地开发

```powershell
node gate\verify-patch.mjs     # 273 条源码断言，离线、不需要 key
node gate\test-coverage.mjs    # 53 条自包含回归，自带 mock，不需要 key
node bin\ocg.mjs doctor        # 九项体检
```

需要真实上游的套件（会消耗配额）：

```powershell
pwsh -File scripts\regress.ps1                 # 离线 + 6 套真实上游
pwsh -File scripts\regress.ps1 -IncludeSoak    # 加 60 秒 soak
```

## 改代码前必须知道的三个坑

1. **`.ps1` 必须带 UTF-8 BOM（或纯 ASCII）**：PS 5.1 在中文 Windows 按 GBK 解码无 BOM 脚本，
   `0x5C` 会被当成转义符，导致解析失败、计划任务起不来。改完用
   `[Parser]::ParseFile` 验证 0 错误；`scripts\regress.ps1` 里有这项检查。
2. **`.cmd/.ps1` 用 CRLF，其他文本用 LF**：与 `.gitattributes` 一致，别让归档出现混合行尾。
3. **判据常量只能写进 `gate/baseline.mjs`**：`verify-patch` 会断言其他文件不得复制这些字面量。
   改判据要同步更新 `docs/BASELINE.md` 的观测日期。

## PR 检查单

- [ ] `node gate\verify-patch.mjs` 全绿（新增不变量请补断言）
- [ ] `node gate\test-coverage.mjs` 全绿（新增行为请补用例）
- [ ] 未引入第三方依赖（`node bin\ocg.mjs audit` 里"第三方依赖"应为 0）
- [ ] 未把 key、token、本机路径写进代码、日志、文档或测试夹具
- [ ] 涉及 CLI / 安装的改动，在 Windows 上真机跑过一遍
- [ ] `docs/CHANGELOG.md` 加一条，标注影响面（网络 / 文件 / env）

## 提交信息

`<scope>: <一句话>`，例如 `gate: 冷却键加入体积档`、`docs: 补 dsh 补丁层结构说明`。
不要求签名，但请一次 PR 只做一件事。
