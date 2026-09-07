# 持久运行时与上下文工程：补充论文核验笔记

日期：2026-09-05。补充 [既有调研](2026-code-mode-context-engineering.zh.md)，不代表已实现。以下四篇均核对 arXiv 标题、提交日期，并打开 HTML 全文核验方法、实验或局限；不是仅据搜索摘要引用。均为预印本，本次未独立复现。对 Prime 的建议标为研究者推断，与论文直接结果分开。

## 1. Fresh Memory, Stale Plans: Dependency-Scoped Validation for Distributed LLM-Agent Memory

Evan Chen、Shiqiang Wang、Christopher G. Brinton；2026-09-03，v1。[元数据](https://arxiv.org/abs/2609.03340v1)；[全文 §5.2、§6、附录 A.5](https://arxiv.org/html/2609.03340v1)。

**已核验结果**：PlanFence 记录计划依赖的精确输入版本，在执行前验证、必要时重规划。三个工作流族、五个 Qwen3.5 agent、每族十个种子的受控实验故意在规划后插入一次需求修订：仅读取最新状态的策略 30/30 执行旧计划；PlanFence 与集中式 lineage 检查均 30/30 完成且无无效主动作。

**边界**：这不是自然任务失败率，也不是通用能力提升。依赖必须完整，owner 可信；验证不与跨 owner 更新或外部动作原子化，不能解决全部 TOCTOU。

**Prime 推断**：变量仍存活不代表其中的文件快照、结论及派生修改计划仍有效。子任务报告宜携带影响决策的文件/版本与未核实条件；执行修改前使用 DSH 原生工具的当前内容检查。优先增加「读入变量→外部修改→按旧结论行动」的评测，不立即实现通用依赖图或自动拦截层；工具权限、事务边界仍归 DSH。

## 2. Beyond Context Windows: Persistent Discovery Context for Data-Centric Agents

Jalal Mahmud；2026-09-02，v1。[元数据](https://arxiv.org/abs/2609.02129v1)；[全文 §3、附录 C/F](https://arxiv.org/html/2609.02129v1)。

**已核验结果**：保留意图到数据对象的映射并辅助检索排序。在三套小型关系数据环境、15 个任务族、125 个留出任务上，TF-IDF 的 F1@5 从 0.396/0.299/0.446 提升至 0.499/0.482/0.528。错误但语义相近的记忆可使结果低于无记忆基线；LLM 自动构建的记忆在 Northwind 也未优于 registry-only。

**边界**：主指标是对象检索，任务族共用对象集合；不是全仓编码、长期在线记忆或任务成功率的证据。

**Prime 推断**：变量目录可优先让模型重新找到「本次任务已定位的路径、命名变量和来源」，避免再次搜索；首先利用现有 Realm 变量/任务文件，不新增向量库。映射只作导航候选，不能覆盖当前搜索证据。任务材料不写进 `refine` continual state。评测加入名称相近但职责不同、路径移动及旧映射误导的负例。

## 3. CompactionRL: Reinforcement Learning with Context Compaction for Long-Horizon Agents

Yujiang Li 等；2026-07-06，v1。[元数据](https://arxiv.org/abs/2607.05378v1)；[全文 §4.1、§5.1–5.2](https://arxiv.org/html/2607.05378v1)。

**已核验结果**：联合训练执行与摘要。更直接可用的是固定 GLM-4.7-Flash 执行模型、只换摘要模型的对照：SWE-bench Verified pass@1 为 49.0、50.5、55.5，相差 6.5 个百分点。论文评测用随机抽取的 200 个 Verified 任务、完整 Terminal-Bench 2.0，每设置两次运行，最多三次压缩；执行 scaffold 为 Terminus-KIRA。

**边界**：不是全量 Verified；RL 训练收益不能归因于一条摘要提示。持久 TypeScript Realm 与 DeepSeek 路由未被验证。

**Prime 推断**：把摘要模型当作独立评测因子，固定执行模型、触发点、摘要预算和任务来比较压缩后的完成率；不能默认便宜模型足够，也不能只调低 thresholdRatio 后宣布优化。至少测一次及三次压缩，核对未解决错误、当前文件状态、变量引用的后续利用。若 DSH 公开 seam 不支持独立摘要路由，先用离线重放测出价值，再讨论上游能力；不在 Prime 私建第二条压缩生命周期。

## 4. Argus: A General-Purpose Agentic Reasoning Runtime for Long-Horizon Tasks

Boxiu Li 等；初稿 2026-08-05，v2 2026-08-07。元数据 v2 使用本节标题；搜索索引/v1 可见不同标题，引用固定到 v2。[元数据](https://arxiv.org/abs/2608.05144v2)；[全文](https://arxiv.org/html/2608.05144v2)。

**已核验结果**：持久项目状态上运行有界任务并经审阅接纳经验。作者报告 SWE-Bench Pro 约 78% 对 Direct Copilot 59%，总 token 为 1.41 倍。后期 wave 的输入 token 与时间下降是同一任务序列中的观察，不是持久记忆的独立消融；论文明确需要冻结状态、打乱任务顺序和随机审阅路由的对照。

**边界**：完整系统比较混合了角色分工、审阅及持久状态等因素；不能推出「多加 reviewer」或「自动 refine」必然更省钱。

**Prime 推断**：利用现有 `refine` 的 inspect/apply/rollback 检验少量可复用策略，不迁入完整四角色架构。学习收益比较应固定任务与执行模型，交叉运行冻结的旧/新 continual revision，并记录任务顺序；避免把模型越来越熟悉仓库、后期任务更简单或额外审阅预算误算成学习效果。具体 refine 实现仍须先核对仓库规定的上游基线。

## 5. 建议新增的最小实验

以下是面向本项目的实验设计，不是论文已证明的结论。

| 实验 | 唯一主要变化 | 观察结果 | 失败场景 |
| --- | --- | --- | --- |
| 持久状态过期 | 文件/需求在读取后变化 | 是否重新校验受影响结论、是否错改 | compaction 后继续旧计划；子报告过期 |
| 发现结果复用 | 给出已定位结果的可回取索引 | 成功任务成本、重复读取、定位准确率 | 同名职责、移动文件、错误历史映射 |
| 摘要模型质量 | 固定 executor，只换 summarizer | 压缩后完成率、成本、恢复调用数 | 一次/三次压缩；关键错误与变量名丢失 |
| continual 策略效果 | 固定旧/新 revision 并交叉任务顺序 | 每成功任务成本与退化任务数 | 错误经验、验证器不完整、顺序偏差 |

优先级：先做持久状态过期与摘要质量评测，再决定变量目录和学习策略是否值得追加实现。四篇论文没有提供直接替换 Prime 运行时的证据。
