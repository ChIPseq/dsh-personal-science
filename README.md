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
| `/night` | 长窗口（夜）：`start` 开窗 / `tick --spent <元>` 记花费并判停 / `close --reason …` 收口 / `status` 看状态。写 `sci/night.json`，`brief` 注入里会多一行夜窗状态 |
| `/inbox` | 投放箱清单：有哪些待处理文件、按扩展名给的建议归属、一句可直接发给模型的处理指令 |

## 长窗口（夜）

科研 agent 最容易丢的不是工具调用，是**时钟**：「窗口还开着、预算没花完、05:40 才停」是时钟上的事实，不是仓库里的事实——压缩一次就没了。所以窗口有文件、有命令、有一行注入：

```bash
/night start --cap 4.8          # 开窗；写 sci/night.json，并提示排第一个 tick
/night tick --spent 1.20        # 每代 tick 调用；返回 stop=false / stop=true(cap|time)
/night close --reason cap       # 收口；cap|time|external|queue_empty，缺理由直接拒绝
```

- `close` **必须带理由**：`cap` / `time` 是正常收工；`external` / `queue_empty` 会标 `weak`——等于承认这一夜没跑满。
- `brief` 注入会多一行：`【夜窗 #5】¥1.20/4.8 · 距收窗 6h32m · stop=false`。
- `/where` 会红字提示两种失控：`STATE.md` 比台账旧 30 分钟以上；夜窗到了停止条件却没 `close`。
- 插件不知道价格，`--spent` 由调用方（项目脚本）提供；它只负责和上限、时钟比。


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

---

# 本仓内的科研项目：QSAR 泛化审计（「过程即结果」）

> 上面的内容是 **插件层**（personal-science 给 DSH 的科研状态位）；下面描述的是**本仓正在跑的一个真实科研项目**。两层共用这个 git 仓：插件代码在 `lib/`、`scripts/`、`test/`，科研项目在 `dsh-science-x1/`、`Plan_Summary/`、`journal/`、`cost/`。

## 是什么

「过程即结果」是一个**夜研（nightly research）**项目：一个 router 会话（母）在每晚 22:00 派工，一个 worker 子代理（x1）执行，把每一夜的选题、尝试、失败、结论都落成文件。研究对象是一个可证伪的方法学问题：

> **在 ChEMBL 公开数据上，随机分割报告的 QSAR 性能有多少是分割协议泄漏造成的？**

## 为什么做

随机分割是 QSAR 基准的默认做法，但它会把「同骨架/同化学邻域」的分子分到训练集和测试集两侧，导致性能被系统性高估。这件事学界都知道，但缺少**多靶点、可复现、把基线定义讲清楚**的量化审计。这个项目的目标是给出可复查的数字，以及一份「泄漏膨胀该跟什么一起报告」的方法学建议；**负结果同样算结果**（三个假设里有两个被否证）。

## 夜研循环怎么运转

1. **22:00 开工**：母会话读 `dsh-science-x1/sci/STATE.md` 与 `journal/` 最近记录，定今晚 1 个主任务 + 1 个备用，通过 `send_message` 派给 x1（x1 不在则 `subagent` 新建）。
2. **夜内**：x1 按「先设计后代码」执行——先写 `Experiment/<需求日期>_<主题>/design.md`，再写脚本；每个可判定结论立刻追加 `sci/log/<日期>.md`（`## HH:MM · 标题` 节），并更新 `sci/STATE.md`（≤45 行）；试过不行的路线追加 `sci/dead-ends.md`。
3. **02:00 巡检**：母查 x1 是否卡住（>20 min 无进展）、是否接近预算，必要时 steer。
4. **06:00 收工**：母结算 `cost/`、写 `journal/<日期>.md`（100 词摘要 + 关键路径 + 花费）、更新两边 STATE。
5. **窗口未开**（harness 未启动）则该夜不计入 30 夜——这是用户已知并接受的约束。

## 主结论（一句话）

**在 23 个 ChEMBL 靶点上，随机分割报告的 R² 有约 30%（骨架基线）到 80%（化学邻域基线）是分割协议泄漏：Δ_leak 在 23/23 靶点上为正（scaffold 基线 0.190、Butina 聚类基线 0.519），R² 由随机分割的 0.652 降到骨架 0.462、邻域 0.133；泄漏膨胀与活性悬崖密度无关，与「化学邻域可记忆度」的关系也未能通过外部验证；并且 Δ_leak 本身是数据集骨架冗余度的度量（test 骨架在 train 出现过的比例 22.5%→64.6%），因此报告泄漏时必须同时报告冗余度。**

## 如何复现

```powershell
$py = 'D:\Software\miniconda3\envs\analysis\python.exe'
$s  = 'D:\workspace\dsh-science\dsh-science-x1\Experiment\20261107_QSAR-audit\scripts'
& $py "$s\01_fetch.py"; & $py "$s\02_clean.py"; & $py "$s\03_profile.py"   # 数据（fetch 幂等）
& $py "$s\10_bench_v2.py"                                                  # 23 靶点 bench（~32 min，可续跑）
& $py "$s\11_h2_test.py"; & $py "$s\15_h2p_test.py"; & $py "$s\16_h2p_oos.py"  # H2 / H2′
& $py "$s\18_subsample.py"; & $py "$s\19_subsample_diag.py"                 # H3 + 机制（~55 min）
& $py "$s\20_h1_family.py"; & $py "$s\21_nrecords_weight.py"                 # 稳健性
& $py "$s\23_figures.py"; & $py "$s\20_check_numbers.py"                     # 图 + 数字审计
```

可读稿：`dsh-science-x1/Report/report.md`（含中英摘要、5 张图、口径与限制）。数字审计：`dsh-science-x1/Experiment/20261107_QSAR-audit/results/number_audit.md`。

## 目录导览

```
dsh-science-x1/                    科研项目（x1 worker 的工作区）
├─ README.md                       worker 的工作约定（本文件的精简版）
├─ Report/report.md                报告 v3（可读稿）；Report/figures/ 5 张图
├─ sci/STATE.md                    当前状态快照（≤45 行）；sci/log/<日期>.md 只追加
├─ sci/dead-ends.md                死路台账（append-only，13 条）
├─ Experiment/20261107_QSAR-audit/ 一次实验一个目录
│  ├─ design.md                    设计 + 夜次修订（含 H2′-rescue 预注册）
│  ├─ scripts/01–27                全部可重跑脚本
│  ├─ data/{raw,clean}/            raw JSONL.gz + 清洗后 CSV
│  └─ results/                     所有数字与表的落地处（profile/bench/h2/h3p/h3b/audit）
├─ Plan_Summary/                   选题与计划文档
└─ Plan/NIGHT_PROTOCOL.md          夜研协议（22:00/02:00/06:00）

journal/                           母会话的每日记录 + INDEX.md（夜次索引）
cost/                              花费台账（update-cost.mjs 结算）
sci/                               母会话的 sci 状态（与 x1 的一一对应）
runbooks/                          运维手册（重启恢复 / STOP / 手动补跑 / 成本结算）
```

## 当前状态（2026-11-13，夜 20）

- **进度**：20/30 夜；累计花费 **¥7.92**（日限 ¥5 与总限 ¥150 均未触及）；中断 1 次（11-11 窗口未开，不计夜次）。
- **报告**：`dsh-science-x1/Report/report.md` v3（中英摘要 + §1–§10 + §5.5 方法）+ **6 张图**；数字审计 **26/26** 一致。
- **已定稿结论**：H1（23/23 全正、双基线、R² 链条 0.652→0.462→0.133）、H2 否证、H2′ 外部验证 FAIL、H3 靶点内支持、Δ_leak=骨架冗余度；assay_type 与描述符族稳健性均已完成。
- **开放项（都只等 ChEMBL API）**：① H2′-rescue（预注册，13 候选已定，脚本 `25→26→27` 就绪）；② 复现抽检的 fetch 环节（`30_repro_check.py`，当前为 PARTIAL）。
- 详见 `journal/INDEX.md`（夜次时间线）与 `dsh-science-x1/sci/STATE.md`（当前判断）。

## 复盘：这套夜研循环跑起来怎么样（22 夜后）

- **做对的（保留）**：先设计后代码。每夜先写 design.md（清洗口径、分割定义、预注册判定线），再写脚本；结果全部落盘到 
esults/，并用 20_check_numbers.py 让报告与数字源做 26/26 对账。这套纪律的直接收益是：三个假设里两个被干净否证（H2）、一个被外部验证判 FAIL（H2′），负结果照样能写成有信息量的结论。
- **踩坑（已固化）**：分组切分里的「任意自由度」会翻结论——scaffold 同尺寸组的排序、Butina 的阈值，前者让单次值与多样本均值差 0.1 R²、后者让 Δ_leak 均值从 0.66 降到 0.38；另有一次 greedy_fill 内部重排导致「5 个 seed 结果完全相同」的假象。对策已写进协议：**分组切分必须报多样本均值 ± swing，并写明阈值**。
- **最大的成本不是钱**：22 夜累计 ¥7.92（≈¥0.36/夜，远低于 ¥5/夜上限）；真正稀缺的是每晚 2–4 小时的窗口，以及**外部依赖**——ChEMBL API 从夜 14 起间歇性 500，使 rescue 与复现 fetch 两项卡了 9 个夜次。教训：外部依赖要有「降级路径」，并把「方法失败」与「依赖失败」分开记账。
- **中断**：11-11 窗口未开（不计夜次）；STOP 机制全程未被触发。夜次按「派工段」计数而非日历天，一个窗口内可跑多段（夜 1–9 都在同一个窗口完成）。
- **可复现性**：独立目录重跑「数据→模型」30/30 项 diff=0.0000；但 fetch 环节因 API 故障仍是 PARTIAL——端到端复现要等 API 恢复后才能补上。

## 预算与窗口约束

- 窗口：每晚 **22:00–06:00**（Asia/Shanghai）；白天不工作（除非母显式派活）。
- 预算：**每日 ≤ ¥5，总计 ≤ ¥150**，**30 夜**为上限；单命令 ≤10 分钟（长命令走后台作业）；不下载 >1GB；不写密钥。
- 当前：**20/30 夜**，累计 **¥7.92**（母侧已结算至 11-13）；中断 1 次（11-11 窗口未开，不计夜次）。

## STOP 机制

- 项目根出现 `STOP` 文件 → **母会话跳过一切动作**（不派工、不巡检、不结算），只在 `journal/<日期>.md` 记一行；文件删除后恢复。
- x1 收到派工后发现 `STOP` 存在 → 不执行，直接写一行记录并结束。
- 夜间若 x1 卡住 >20 分钟无进展，母用 `send_message` steer「收尾或继续」；x1 收尾时必须先落盘 STATE + 日志，再结束回合。
