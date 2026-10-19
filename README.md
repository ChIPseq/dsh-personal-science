# dsh-personal-science

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**个人科研层**：把科研状态从"对话里"搬到"每一步都自动注入的上下文里"，并且不新增任何 agent 工具。

> 结论先行：科研 agent 缺的不是工具，是**工作记忆**。它已经会用 `read`/`write`/`pwsh` 做任何事；它缺的是"我现在在第几轮、上次为什么放弃、这个分支要验证什么"。

## 它做什么

| 机制 | 实现 | 模型需要配合吗 |
|---|---|---|
| 研究状态注入 | `systemPrompt.context`，每一步注入 ≤2000 字的 `sci/STATE.md` 摘要 | **不需要** |
| 工具台账 | 监听 `tools/result`，自动追加 `sci/ledger/<日期>.jsonl` | **不需要** |
| 分支记账 | 监听 `agent/created`，从 session header 的 `parentSession` 还原探索树 | **不需要**（补方向用 `/branch`） |
| 工作约定 | 随包注册 `personal-science` skill | 按需阅读 |
| 收尾/死路 | `/wrap`、`/deadend`、`/resume` | 人触发 |

**0 个新工具**：插件不注册任何 `xxx_*` 工具。日常动作全部走 DSH 原生的 `read`/`write`/`edit`/`pwsh`/`web_*`。

## 启用方式（opt-in）

只有存在 `<会话工作目录>/sci/` 的项目才被视为科研项目。在没跑过 `/resume` 的目录里，插件**不注入、不写盘、不出现**。

```
/resume        # 初始化 sci/ 并显示状态（首次使用跑一次）
/branch <方向>  # 记录"这个分支要验证什么"
/deadend <…>   # 记录一条试过但不行的路线
/wrap [结论]    # 收尾：折叠台账进 sci/log/，机械更新 STATE 的「停在哪里」
```

## 项目内产生的结构

```
sci/
├─ STATE.md            # 唯一允许整体重写的快照（<= 45 行 / 1800 字）
├─ log/<日期>.md       # 只追加
├─ dead-ends.md        # 只追加：试过但不行的路线
├─ ledger/<日期>.jsonl # 插件自动写，人不要碰
├─ branches.json       # 探索分支树（父会话 + 方向）
└─ state-history/      # STATE.md 每次整体重写前的归档
```

## 安装

```bash
# 从本地目录装进某个 profile（desktop profile 需在界面内安装）
dsh plugin --profile <name> add file:/path/to/dsh-science
```

Host 半边改动需要重启会话进程（模块热重载按设计忽略 `node_modules`）。

## 开发

```bash
node test/smoke.mjs   # 28 项：mock Cordis ctx，覆盖注入/台账/命令/分支/opt-in 门禁
```

设计取舍见 [docs/DESIGN.md](docs/DESIGN.md)。

## License

MIT
