# dsh-personal-science

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**个人科研层**：给科研项目一个稳定的 `sci/` 状态位，并且**不新增任何 agent 工具**。

> 设计前提是 dogfood 出来的，不是想出来的：科研 agent 缺的不是工具（`read`/`write`/`pwsh` 已经够），缺的是"项目当前处在哪、上次停在哪、试过什么不行"。但**这东西不该每一步都塞进上下文**——大多数时候人只想问一句"任务跑到哪了、结果在哪"。

## 命令（唯一的显式界面）

| 命令 | 用途 |
|---|---|
| `/where` | **日常用这个**。一眼看现在：最近动作（台账倒序）、最近产物（按 mtime）、可能是作业的命令、关键路径、注入自检 |
| `/resume` | 完整状态：STATE 全文 + 今日台账 + 分支 + 项目近况。首次使用会初始化 `sci/` |
| `/wrap [结论]` | 收尾记账：台账折叠进 `sci/log/`，机械更新 STATE 的「停在哪里」并归档旧版 |
| `/deadend <…>` | 记一条"试过但不行"的路线（append-only） |
| `/branch [方向]` | 看探索分支树；带参数记录当前分支要验证什么 |
| `/inject off\|brief\|full` | 自动注入开关（**默认 off**，写 `sci/config.json`，立即生效不需重启） |

## 自动部分（模型零配合）

| 机制 | 实现 |
|---|---|
| 工具台账 | 监听 `tools/result` → `sci/ledger/<日期>.jsonl` |
| 分支记账 | 监听 `agent/created`，从 session header 的 `parentSession` 还原探索树 |
| 工作约定 | 随包注册 `personal-science` skill |

## 自动注入是可选的

`inject` 三档，存在 `sci/config.json`：

- `off`（默认）：不注入。日常用 `/where`。
- `brief`：每一步注入一行状态（~100 字）。
- `full`：会话前 2 步注入完整 STATE 摘要，之后自动回落到 `brief`。

改成 `off` 是因为第一轮实跑反馈：完整 STATE 每步都注入"太重"，而真正高频的问题是"任务跑到哪了"——那属于 `/where`，不属于 system prompt。

## 启用方式（opt-in）

只有存在 `<会话工作目录>/sci/` 的项目才被视为科研项目。没跑过 `/resume` 的目录里，插件**不注入、不写盘、不出现**。

## 项目内产生的结构

```
sci/
├─ STATE.md            # 状态快照（<= 45 行 / 1800 字），唯一允许整体重写
├─ log/<日期>.md       # 只追加
├─ dead-ends.md        # 只追加：试过但不行的路线
├─ ledger/<日期>.jsonl # 插件自动写，人不要碰
├─ branches.json       # 探索分支树
├─ config.json         # 注入开关
└─ state-history/      # STATE.md 每次整体重写前的归档
```

## 安装

```bash
dsh plugin --profile <name> add file:/path/to/dsh-science
```

Host 半边改动需要重启会话进程（模块热重载按设计忽略 `node_modules`）。

## 开发

```bash
node test/smoke.mjs   # 35 项：mock Cordis ctx，覆盖门禁/台账/六个命令/分支/注入三档
```

设计取舍见 [docs/DESIGN.md](docs/DESIGN.md)。

## License

MIT
