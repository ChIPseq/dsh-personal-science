# dsh-personal-science

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**个人科研层**：给科研项目一个稳定的 `sci/` 状态位，并且**不新增任何 agent 工具**。

> 设计前提是 dogfood 出来的，不是想出来的：科研 agent 缺的不是工具（`read`/`write`/`pwsh` 已经够），缺的是"项目当前处在哪、上次停在哪、试过什么不行"。但**这东西不该每一步都塞进上下文**——大多数时候人只想问一句"任务跑到哪了、结果在哪"。

## 命令（唯一的显式界面）

> ⚠️ **输出不走命令卡片。** 在当前的 DSH 桌面版里，profile 插件注册的命令会执行、会落盘 `command/done`，但**卡片不渲染**（`/resume`、`/inbox` 实测都是"什么都没有"）。所以每个命令的结果会**双写**：全文落 `sci/out/<命令>.md`，同时以一行 `【personal-science · 回执】` 投进对话（见下）。

| 命令 | 用途 |
|---|---|
| `/where` | **日常用这个**。一眼看现在：最近动作（台账倒序）、最近产物（按 mtime）、可能是作业的命令、关键路径、注入自检 |
| `/resume` | 完整状态：STATE 全文 + 今日台账 + 分支 + 项目近况。首次使用会初始化 `sci/` |
| `/wrap [结论]` | 收尾记账：台账折叠进 `sci/log/`，机械更新 STATE 的「停在哪里」并归档旧版 |
| `/deadend <…>` | 记一条"试过但不行"的路线（append-only） |
| `/branch [方向]` | 看探索分支树；带参数记录当前分支要验证什么 |
| `/inject` | 自动注入开关：**不带参数就是循环切换**（off→brief→full），也可 `/inject off\|brief\|full`。默认 off，写 `sci/config.json`，立即生效不需重启 |
| `/inbox` | 投放箱清单：有哪些待处理文件、按扩展名给的建议归属、一句可直接发给模型的处理指令 |

## 投放箱（`inbox/`）

用户在项目根建一个固定位置，把想分享的资料（别人发来的调研报告、文献 PDF、数据表、方案）丢进去；**显式**说一句「处理 inbox」，agent 才去读、分类、移动，并把这块地清空。

```
inbox/                  ← 人往里扔文件；自带 .gitignore，默认不进版本控制
├─ README.md            ← 处理规则（给人和模型看）
└─ .gitignore
```

处理规则（写进 skill，agent 照做）：

1. 逐个读到"知道它是什么"，PDF 优先 `pdftotext`，其次 `pypdf`；**读不动的不猜**，留在原地并说明。
2. 按内容判断归属：文献 → `papers/pdf/` + `papers.csv` 登记；报告/综述/方案 → `Plan_Summary/<日期>_<主题>.md`；数据 → `data/`；脚本 → `Experiment/<日期>_<主题>/scripts/`；图 → `figures/`。
3. **移动而非复制**，并在 `sci/log/<日期>.md` 记一行「原文件名 → 目标路径 → 判定理由」。
4. 处理完 `inbox/` 只剩 `README.md` 和 `.gitignore`；有剩余必须说明原因。

`/where` 和 `/resume` 都会显示「收件箱：N 个待处理」，所以你不会忘记里面还有东西。

## 输出怎么到你眼前（命令卡片只有一行）

DSH 桌面版把命令结果显示成**一行**：`> 命令名 · 全文压成一行并截断`（点这一行才展开为 `<pre>`）。`/inbox` 那一屏清单，在会话里就是一条灰色小行——不点开等于没看见。所以命令输出不再只靠 `result.text`：

| `sci/config.json` 的 `deliver` | 行为 |
|---|---|
| `pending`（默认） | 报告写 `sci/out/<命令>.md`，回执以**隐藏上下文**送到模型下一步（`source.kind: personal-science`，不算用户发言）。不伪造气泡、不额外调用模型 |
| `turn` | 报告写文件，并**开一轮 turn**，回执作为 user 气泡进对话。立刻可见，但它看起来和"你自己打的一段话"一模一样（默认不用） |
| `off` | 只写文件，自己去 `sci/out/<命令>.md` 看 |

回执一律以 `【personal-science · 回执】` 开头；skill 里写死了：`pending` 时模型把它当背景、用户问起再复述，`turn` 时只做一句话确认——两种情况都不许动文件。

**日常读状态别用命令**：直接问"现在到哪了 / 结果在哪个文件 / inbox 里有什么"，模型自己读 `sci/` 和 `inbox/` 再答，输出是你熟悉的正常回复。命令只是确定性快捷方式，它的卡片只够看一眼摘要。

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
├─ out/<命令>.md       # 每个命令的完整回执（插件自动写，卡片不可靠的替代）
├─ config.json         # 注入开关 / 收件箱路径 / 回执投递方式
└─ state-history/      # STATE.md 每次整体重写前的归档

inbox/                 # 投放箱（人放、agent 处理、处理完清空）
├─ README.md
└─ .gitignore
```

## 安装

```bash
dsh plugin --profile <name> add file:/path/to/dsh-science
```

Host 半边改动需要重启会话进程（模块热重载按设计忽略 `node_modules`）。

## 开发

```bash
node test/smoke.mjs   # 56 项：mock Cordis ctx，覆盖门禁/台账/七个命令/分支/注入三档/收件箱/回执投递
```

## 发布

```bash
node scripts/release.mjs --dry-run           # 只打印计划：版本、tag、Release notes
node scripts/release.mjs --yes               # 用 package.json 的版本发：tag → push → GitHub Release
node scripts/release.mjs --bump patch --yes  # 0.3.0 → 0.3.1，自动改 package.json 并提交
node scripts/release.mjs --notes notes.md --yes
node scripts/release.mjs --no-release --yes  # 只打 tag + push
```

它会先校验：在 `main` 上、工作树干净、本地与 `origin/main` 一致、tag 不存在。
Release notes 默认取上一个 tag 以来的提交；凭据依次读 `GH_TOKEN` / `GITHUB_TOKEN` / `git credential fill`（不落盘、不回显）。

> 用 Node 而不是 PowerShell 发 API 是有原因的：`Invoke-RestMethod` 会把中文 body 按 ISO-8859-1 编码，GitHub 直接回 `Problems parsing JSON`。

设计取舍见 [docs/DESIGN.md](docs/DESIGN.md)。

## License

MIT
