# Prime Realm 自动 Completion History 与有界输出投影计划

> 状态：设计计划，尚未实施  
> 上游参考：PrimeIntellect-ai/prime-agent `aacf04b4678fd02cf46b69ab0bdcbc5d29baab45`  
> 目标仓库：`dsh-prime-agent`

## 1. 背景与问题

当前 Prime Realm 已经让普通顶层变量、函数和对象跨 `run_code` cell 存活，但模型可见输出仍沿用“完成值必须完整、无损地穿过 host 边界”的契约：Worker 对末尾表达式做 lossless JSON 转换，`console.log` 与完成值共同计入 `maxOutputBytes`；一旦越界，当前 run 返回 `output-limit`，不会保留一个可再次寻址的自动结果槽。

这产生了错误的职责分配：为了避免大 JSON 进入上下文，模型必须主动命名变量、切片、计数和组织摘要。该做法不稳定，并会占用模型对真实任务的注意力。输出治理和工作集管理应由 Realm runtime 完成，而不是由提示词要求模型遵循格式。

本计划把 Prime 模式调整为：

- 模型自然编写代码，不负责控制模型投影大小；
- Realm 自动保留 cell completion；
- runtime 对模型可见 completion 生成严格有界的确定性投影；
- 大 completion 不再仅因展示过大而让已成功执行的 cell 失败；
- runtime-owned completion history 有独立、确定、可观测的回收语义；
- 用户声明的普通 binding 仍不被 runtime 隐式删除。

## 2. 上游设计依据

Python Prime Agent 依赖 IPython 的原生能力，而不是复杂的模型提示规则：

1. IPython 自动通过 `_`、`_N` 和 `Out[N]` 保存 cell completion。模型不显式赋值时，结果仍可继续计算。
2. Kernel 仅把 `stdout`、`stderr` 和最后一个 `execute_result` 的模型投影截断；默认上限为 65,536 字符。底层 IPython 对象不会因为展示截断而消失。
3. Session 恢复使用 per-variable `dill` snapshot：默认单变量 16 MiB、总快照 256 MiB；单个变量不可序列化不会阻断其他变量。
4. compaction snapshot 可删除超过单变量上限的 live name，并同时清理指向相同对象的 `Out` cache entry，避免缓存继续持有对象。
5. IPython 工具说明只陈述持久 kernel 语义，不要求模型遵循摘要输出格式。

对应上游位置：

- `../prime-agent/packages/coding-agent/src/core/kernel/index.ts`
- `../prime-agent/packages/coding-agent/src/core/kernel/state-snapshot.ts`
- `../prime-agent/packages/coding-agent/src/core/tools/ipython.ts`
- `../prime-agent/packages/coding-agent/src/core/agent-session.ts`

应移植的是“自动 completion cache + 展示投影与 live object 分离 + runtime-owned cache 回收”这些行为，不移植 Jupyter、ZMQ、Python pickle/dill 或上游 daemon 生命周期。

## 3. 设计原则

1. **任务代码优先**：模型无需为了控制 token 改写任务逻辑。
2. **存储与投影分离**：Realm 中的 completion value 与发送给模型的 projection 是两个独立概念。
3. **小结果兼容**：小 completion 的模型可见结果保持当前形状，不统一包装成冗长 envelope。
4. **大结果可寻址**：大 completion 返回紧凑引用和预览，原值继续留在当前 Worker generation。
5. **不扩大跨边界类型**：第一阶段仅自动缓存已满足当前 lossless `CodeJsonValue` 契约的 completion；函数、symbol、bigint、循环结构等仍按当前规则返回 `invalid-output`。
6. **不隐式删除用户 binding**：只回收 runtime-owned completion history；`const x = value` 等用户 binding 仍由用户代码和 Worker generation 生命周期拥有。
7. **generation fencing**：completion reference 只在创建它的 Realm generation 内有效；hard-kill 后全部失效。
8. **确定性有界**：projection 的深度、节点数、数组样本数、字符串长度和序列化字节数均由 runtime 硬限制。
9. **失败可观察**：淘汰、截断、namespace loss 和真正的协议失败必须明确区分。
10. **不复制 DSH 所有权**：工具 canonical value、spill artifact、Session、Compaction 和日志持久化仍由 DSH 原服务拥有。

## 4. 目标模型

### 4.1 自动 completion history

每个成功且 completion 为 lossless `CodeJsonValue` 的 cell，在释放 Inspector object group 前，由 Worker 自动把原值引用加入 generation-local history。存储位于 `realm-worker.ts` 的 Worker module scope，不进入 REPL namespace、host、`stateDirectory` 或 DSH Session；唯一入槽点是现有 boundary bridge 的 completion preparation 路径，因为这里同时持有 live value、精确 JSON 字节数并且尚未释放 object group。

模型可见 API 收敛为两个训练分布内的惯用式，由 Worker boot 时安装为**不可枚举、configurable 的 accessor global**（函数对象本身冻结）。不能装成非 configurable own property：那会让顶层 `const _`/`const $out` 触发 `Identifier has already been declared` 并拒绝整个 cell（`tests/completion-contracts.spec.ts` 已固化今天 `const _` 合法）。保持 configurable 让用户 lexical 声明按 Node REPL 语义自然 shadow/停用；`$out` 被 shadow 或 delete 只是自误伤，history 仍由 runtime 拥有。已知且接受的残留面（评审 P17）：detached continuation 可 `delete` 后 `defineProperty` 伪造同名 accessor，终局与 run 内赋值相同——自伤且 store 不可达；唯一堵法是 non-configurable，会破坏顶层 `const` 契约，因此「按名字缺席重装」定位为修复误删的便利，不是安全边界：

```ts
$_           // 最近一个 completion；DevTools 既有语义；用户显式赋值 $_ 后停用并提示一次（Node REPL 式规则）
$out(17)     // 用整数 handle 取回保留的原值；evicted 或失效时抛 CompletionExpiredError
$out.list()  // 有界 metadata；$out.drop(17) / $out.clear() 显式释放——管理面，不写入模型 schema
```

last 手柄选 `$_` 而不是 `_`：JS 语料中 `_` 的最强先验是 lodash（模型可能写 `_.chunk(...)` 而收到 TypeError），且 `_` 是最常见的弃用变量名，shadow 事件会很频繁；`$_` 在 DevTools console 中正是"上一个求值结果"，先验精确对口，且与 `$out(N)` 组成模型熟知的 `$` 前缀宿主 utilities 家族（`$_`/`$0`/`$x`）。命名暂定为 `$out`，实施前应通过 assembly 与 Realm 回归测试确认 `$_` 与 `$out` 均不和 DSH SDK binding 冲突；若 `$_` 也冲突，降级方案是直接删除 last 手柄、只保留 `$out(N)`（envelope 的 `use` 字段已足够承载取值惯用式）。该 API 不是 host tool，不使用 binding lease，也不获得文件、网络或工具权限；但它必须遵守同等级别的 run fencing：`$_` getter 及所有方法都同步检查当前 `leasedRunId()`，在 run 外或 detached continuation 中明确拒绝访问，避免跨 run 读取或释放 history。

模型可见 handle 是单个小整数，由 host 拥有的计数器在整个 runtime 进程生命周期内全局单调分配，跨 Worker generation 与跨 Realm 均不复用。分配方式是 host 在 dispatch 时为每个 run 下发一个候选 id，Worker 只在真正开新槽时消费（identity-reuse 不消费；id 允许空洞但严格单调）——boot 一次性注入起始值无法闭合：host 不知道上一代 Worker 用掉了多少，而 hard-kill 前模型可能已通过实时日志看到某个 id，该 id 绝不能被新 generation 复用。generation nonce 从模型可见 ref 中移除；Phase 1 尚无 handle 过 wire，nonce 推迟到 Phase 2 与投影一并引入（仅存在于 wire 协议内部做纵深防御），避免死代码。hard-kill 后旧 handle 仍必须 fail closed 为 `CompletionExpiredError`：id 不复用保证旧 handle 在新 generation 的 store 中天然缺席，绝不能静默命中另一个值；runtime 进程重启使计数器归零时，全部 history 同时消失，由现有 restart notice 覆盖。`CompletionExpiredError` 的 message 必须自带恢复指令（如 "result 17 was evicted; recompute it"），把失效场景的文档成本移到仅触发时支付。

### 4.2 小 completion

当完整 completion 与已接纳日志一起低于模型投影阈值时：

- 对外结果保持当前值形状；
- completion 仍自动进入 `$out`；
- 不额外包装 metadata，避免所有正常调用增加 token；
- `$_` 可用于访问最近结果（DevTools 既有语义，零提示词成本）。

### 4.3 大 completion

当完整 completion 是合法 `CodeJsonValue`，但超过 completion projection 阈值时：

- cell 保持成功；
- 原值保留在 `$out`；
- host 只收到固定 schema 的有界 projection；
- projection 自身必须纳入 `maxOutputBytes`，且不能递归溢出。

建议 envelope：

```json
{
  "$out": 17,
  "use": "$out(17)",
  "retained": true,
  "type": "object",
  "serializedBytesAtCapture": 75231,
  "projection": {
    "type": "object",
    "keyCount": 2,
    "keys": [
      {"key": "matches", "value": {"type": "array", "length": 384}},
      {"key": "kkk…", "keyLength": 20000}
    ]
  },
  "truncated": true
}
```

`keys` 用条目数组而不是按 key 名索引的对象：两个截断后前缀相同的超长 key 会撞成同一个 JSON key 并被 `JSON.stringify` 静默丢弃（用户可构造的确定性丢数据）；`keyLength` 就地标注原长，未访问的兄弟条目只有 `key` 没有 `value`（A5 的诚实形态）。

这不是让模型遵循的输出格式，而是 runtime 的工具结果协议。`use` 字段是可直接照抄的取值表达式：契约在需要它的那一刻随结果就地出现，不依赖 schema 预先教学——模型对"复制输出中的表达式"有强训练先验。

`retained: false` 时省略 `$out`/`use`（死 handle 比没有更糟——模型照抄 `use` 会立刻吃 `CompletionExpiredError`）。`serializedBytesAtCapture` 的口径是**测到就报、没测到就省**，不是按 retained 判断：经总预算（estimatedBytes）拒绝保留的值走查已完成、字节数是真实测量值，照报并配 `reason: "too large to retain"`；撞早退线的值未测量，省略该字段并配 `reason: "too large to capture"`——不报没测过的数，也不报会误导的下界。「已测量但拒绝保留」只能经总预算路径到达（单槽天花板与早退线的取值关系使其余组合自相矛盾）。minimal envelope 因此有带 handle（约 50 B）与不带 handle（约 32 B）两种形态，128 B 常量覆盖两者，与 notice reserve 同处测试钉住。`maxCompletionProjectionBytes` 只约束 rich envelope；minimal 档由 wire 预算兜底（否则最后一档不可达）。已知行为（Phase 2 评审 B 项）：降级是整档的——rich 超预算直接落 minimal，中等复杂形状（如 16³ 叶子的嵌套对象）会拿到零结构信息的 45 字节引用；潜在改进（rich 超预算先降 depth=1 重试再落 minimal）留 Phase 3+ 以 `completionsMinimal` 实测使用率决定，不预做。

### 4.4 有界确定性 projector

projector 不调用 LLM，不做语义总结。建议规则：

- primitive：原值；
- string：长度、前缀和必要时后缀；
- array：总长度和前 N 个递归投影项；
- object：总 key 数、前 N 个 key 及其递归投影；
- 超长 key 自身按字符串规则截断并标注原长度，避免单个 key 吃穿预算（当前边界对 key 长度无限制，20000 字符 key 已被契约测试固化为合法输入）；
- 最大深度、最大节点数、单字符串字符数、数组样本数、对象 key 数和最终 UTF-8 字节数全部硬限制；
- key 顺序保持 canonical value 原顺序；
- Phase 0 定案的初始限制：最大深度 4、数组样本 8、对象 key 样本 16、单字符串 256 字符、projection 节点 512、单次投影 4096 字节；
- projector 与大 completion 的准入必须是带早退的有界遍历，不得构造完整 snapshot；早退线取 **`max(maxCompletionHistoryEntryBytes, maxCompletionFullBytes)`** 与 `maxCompletionHistoryNodes`（Phase 2 实现修正：A3 原论证只在准入天花板 ≥ 投影触发线时成立——若部署把保留预算调小，天花板早退会把本应原样返回的中等结果静默变成引用，即被无关旋钮改掉模型可见契约；越过 `max` 线的值才是「既不能保留也不能整发」）：天花板内走完 ⇒ 拿到精确 bytes/nodes 入槽记账，投影从已有快照生成、零额外成本；撞到天花板 ⇒ 该值本就永远不可能入槽（`retained: false`），立即早退，投影用已采集的有界材料生成——「精确记账」只对会被保留的值保留，走查成本上界为与值大小无关的准入天花板常数（8 MiB 快照实测 72–155 ms）；
- G1 出口判据据此改述为：除「根对象 own keys 恰好枚举一次、绝不二次枚举」外，捕获与投影成本 O(准入天花板)；wide-object 的单次枚举地板（233 万 key 实测 857–1952 ms，V8 枚举缓存整体物化、break 不省钱）是已测量的已知底线，不是未达标项；
- 深度优先内联采集撞到天花板时，根对象未访问兄弟的 key 只给名字、不给样本（不为补样本触发额外 getter 副作用），envelope 标 `truncated: true`；中止检查必须位于 key 名记账之后、属性读取之前——否则恰好在 key 名那一笔越线时会多读一个属性（触发本已决定不碰的 getter，且该 getter 抛出会把本该成功的投影变成 invalid-output）；修正时 `visited` 取当前 index 而非 index+1，防止「只命名不读取」补全循环漏掉该 key（Phase 2 评审 A 项）；
- 准入判定必须在遍历过程中进行，不能遍历完再算：`snapshotValue` 的 `seen` 是路径集合（退出时 delete，realm-worker.ts:674），只拒环不识共享，共享子图在边界指数展开（实测 1644 节点的 DAG 展开成 6718 万节点 / 67 MiB JSON）——遍历后判定意味着放大已全部发生；
- key 枚举只做一次：字典模式大对象上不存在廉价的「取前 N 个 key」（64 MiB wide-object 上 `Object.keys().slice` 857 ms、`Reflect.ownKeys` 1952 ms），key 总数与样本必须在捕获遍历中一次取得，projector 不得重新枚举；
- projector 必须能在剩余输出预算内降级为最小引用 envelope；
- 第一阶段不引入 `grep`/`glob` 等工具专用语义摘要，避免 Realm runtime 复制 DSH 工具知识。确有数据证明通用 projector 不足后，再在 DSH-owned projection seam 评估结构化 adapter。

## 5. History 生命周期与内存治理

### 5.1 所有权

History 保存原 completion 的 Realm 内引用，语义接近 IPython `Out`。如果相同对象同时被用户 binding 引用，`$out.drop(id)` 只释放 history 的引用，不影响用户 binding。

### 5.2 初始限制

新增 runtime 配置，默认值已由 Phase 0 基准（`docs/plan/phase0-bench-results.zh.md`）定案：

- `maxCompletionHistoryEntries` = 16（8 在 explore 型 trace 下不够）；
- `maxCompletionHistoryEstimatedBytes` = 32 MiB（512 MiB 老生代下 128 MiB 直接 OOM、64 MiB 贴边；32 MiB 实测驻留约 48 MiB，占 `maxOldGenerationSizeMb` 的 9.4%）；
- `maxCompletionHistoryNodes` = 1,000,000（node 预算才是真正的 heap 约束项：16 MiB 合法 JSON 最坏对应 341 MiB 活对象图，21.3×；identity 最坏 64 B/node）；
- `maxCompletionHistoryEntryBytes` = 8 MiB（总预算 1/4 的单槽上限，防单个大结果清空全部历史；上游 IPython 比例为 1/16，此处已更宽松）；
- `maxCompletionProjectionBytes` = 4096（实测 rich envelope 265–985 B、minimal reference envelope 86–119 B；最小 envelope 字节常量定为 128 B）；
- `maxCompletionFullBytes` = 65,536（64 KiB）：全量返回的触发线——完整序列化不超过它且装得进剩余预算时原样返回，超过则投影。取值对齐上游 IPython 单流 65,536 字符截断的训练先验；不与 4096 合并成一个旋钮，是为了不把 4–64 KiB 的中等结果也推去投影——那会抬高重复工具调用率，违反验收 #16；
- 可选 `maxLogProjectionBytes`：Phase 3 再定。

首版采用 FIFO/旧 completion 优先淘汰，而不是 access-based LRU：顺序确定、测试简单，也更接近 notebook output cache 的历史语义。访问旧结果不应无限延长其生命周期。重复引用同一对象（含 `$out(id)` 直接作为末尾表达式的回流形态）定案为 **identity-reuse**：命中身份则不开新槽、不分配新 id、不重复计费，直接返回已有 id 并保持其原 FIFO 位置。Phase 0 基准显示按槽独立计费在三种回流 trace 中的两种刷穿 history，且失效形态最坏——对象仍在 store 里只是换了 id，模型手上的句柄却 expired；identity-dedup（去重计费但仍开新槽）也救不了 entries 预算被回流吃掉的场景。store 仅 16 槽，身份命中用线性扫描即可，不为此引入 WeakMap 反查。filter-chain trace 证明该语义不影响正常派生用法。身份扫描仅对 object 值进行：`Object.is` 对原始量是值比较，对同前缀长字符串是 memcmp（16 个 8 MiB 同前缀字符串最坏每次捕获扫 128 MiB，破坏有界成本）；原始量因此每次开新槽，由 entries/bytes 预算自然约束。

`serializedBytesAtCapture` 和 node count 都只是准入近似：JSON 字节可能严重低估真实对象图 heap，对象后续也可能被代码原地修改。因此默认 history 预算必须保守且显著低于 `maxOldGenerationSizeMb`；二者不能替代 Worker heap 硬边界。

保留物定案为原对象引用（identity）。Phase 0 基准推翻了「snapshot 副本是只花内存不花 CPU 的现成品」的假设：`snapshotValue` 用 `Object.create(null)` 构造 null-prototype 对象（realm-worker.ts:663），V8 将其放入字典模式，副本比原对象更重——最贴近真实工具输出的 record-array 形状贵 2.4×，有用户 binding 并存时贵 1.7–2.8×，最坏形状 `[{},{},…]` 16 MiB JSON 对应原对象 341 MiB、副本 1048 MiB。identity 的 capture bytes 漂移是真实且量级级别的（实测向上 11.8×、向下到 0、还能变成非 JSON），处置方式不是换保留物，而是承认记账性质：`serializedBytesAtCapture` 是捕获时的诚实快照，bytes/nodes 均为准入近似，唯一 heap 硬边界仍是 `maxOldGenerationSizeMb`。

### 5.3 淘汰

- 新 completion 入库前按 entries、捕获时估算字节和 node 数三重预算淘汰最旧槽；
- 单个 completion 自身超过任一 history 准入预算时，不应为它清空全部历史；应返回 `retained: false` 的有界 projection，并给出原因；
- `drop/clear` 幂等；`$_` 指向最近一次成功入槽或 identity 命中的 completion（独立 lastId 指针，与 FIFO 位置解耦——identity-reuse 保持槽的原 FIFO 位置，但 `$_` 仍指向它）；该槽被 drop/evict 或空 history 时返回 `undefined`；
- `$out(evictedId)` 或旧 generation handle 抛出明确的 `CompletionExpiredError`（message 自带恢复指令），不能静默返回错误对象或新 generation 数据；
- `$out.list()` 只包含 id、type、捕获字节数和创建顺序等小 metadata；
- hard-kill、idle/LRU Realm 回收和 runtime dispose 会释放整个 history；
- namespace restart notice 应同时说明 completion history 已丢失，不新增第二条独立 restart 机制；
- idle/LRU 回收后的新 Realm 走 fresh notice（`started empty`），不额外说明 handle 丢失——新 Realm 对「此前是否存在同 session 旧 Realm」不保留状态，丢失场景由 `CompletionExpiredError` 的恢复指令兜底；该决策需用例钉住。

## 6. 输出预算与日志

### 6.1 预算分层

应区分三类预算：

1. **Worker heap 预算**：`maxOldGenerationSizeMb`，保护进程；
2. **completion history 预算**：限制 runtime-owned 强引用；
3. **模型投影预算**：限制每次进入对话的 logs + completion projection。

`maxOutputBytes` 继续作为 host 边界最终硬上限，保证协议消息始终有界；但合法的大 completion 不再因为完整值无法穿过该边界而失败。现有 host `OutputLedger` 已按实际 wire JSON 字节计账，因此 Phase 2 不改变 ledger 的基本语义：Worker 发出 envelope 后，host 自然按投影字节结算。必须定义最小引用 envelope 的字节上界和 `full → rich projection → minimal reference → output-limit` 降级链；只有 minimal reference 也无法装入剩余预算时才返回 `output-limit`。最小 envelope 常量必须以最坏合法配置为准：realm 可被配置到 `MIN_OUTPUT_BYTES = 256`，扣除 ledger 基础开销后 completion 仅约 254 字节可用，§4.3 示例 envelope（约 200 字节）接近吃满——minimal reference envelope 必须显著更小（目标数十字节量级，如 `{"$out":17,"use":"$out(17)","truncated":true}`）。另外当前 completion 越界走 `ledger.failure`（保留全部已接纳日志），只有 `limit()` 才做日志前缀截断；Phase 2 把大 completion 改为成功 projection 后必须重对这条路径的日志账，否则验收 #12 会在边界失守。定案：投影触发线为 `maxCompletionFullBytes`（完整序列化超过它即投影，即使剩余预算装得下全量）；日志吃掉预算、连 minimal envelope 都装不下时走 `ledger.limit()`——唯一保证 wire 字节不超 cap 的路径，日志按其既定语义截为整条前缀。

### 6.2 日志处理分阶段

上游对 `stdout`、`stderr` 与 `execute_result` 独立截断。为降低一次性协议变更风险，本项目分两步实施：

- Phase 1 只建立 completion history，保留现有日志 admission 和日志失控处理；
- Phase 2 虚拟化大 completion，不为 DSH 侧 `CodeRunResult` 新增顶层字段；full/projected 的判别由内部 worker→host done fragment 上的模型不可见 `projected` 标志承载，不依赖 envelope 键形状；
- Phase 3 再把 `console.log` 改为有界收集。由于当前 peer `CodeRunResult` 只有 `{ value, logs, error }`，截断信息使用一个有界 marker 日志条目承载，而不是虚构 `logsTruncated` 顶层字段。保留日志 head-prefix，为 marker 预留固定预算并记录 dropped entries/bytes；native output、协议违规和无法容纳最小诊断时仍可 hard fail。

不得静默丢日志，也不照搬上游 stdout/stderr/result 各自 65,536 字符的独立上限，因为三份独立预算可能突破本项目统一的 wire cap。截断不得劈开 Unicode 代理对，也不能改变 cell 已发生的外部副作用事实。

## 7. Worker 与协议改造位置

### 7.1 `src/realm/realm-worker.ts`

- 在 Worker module scope 建立 generation-local completion store；不把 history 放在 host、`stateDirectory` 或 DSH Session，也不缓存 cell code；
- host 按 run 下发候选 id（全局单调、绝不复用；identity-reuse 不消费该 id）；generation nonce 推迟到 Phase 2 随投影引入——由 host 生成、随每个 run 消息下发（与候选 completion id 同路，不新增 boot 握手），worker 在 envelope 回填、host 校验相等，用户伪造 envelope 因拿不到当次 nonce 而可判别；Worker 在首个模型 cell 前以不可枚举、configurable 的 accessor 形式安装 `$out` 与 `$_`（函数对象冻结，property 保持 configurable 以免顶层 `const` 声明触发 SyntaxError；setter 语义为降级成普通 data property，不抛）；它们不通过每轮 namespace lease，但所有 getter/method **与 setter** 必须检查 `leasedRunId()`（detached continuation 中赋值同样拒绝——setter 无门控会让遗留 continuation 跨 run 篡改 intrinsic 造成静默拒绝服务）；delete 无法在 configurable 属性上拦截，处置为每个 run 开始时若全局槽位缺席则重装 intrinsic（已被用户 run 内赋值降级的 data property 不复活，尊重停用语义）；
- `Runtime.evaluate` 后、`Runtime.releaseObjectGroup` 前，在现有 completion boundary 的 main-world 路径中：
  1. 执行现有 boundary validation；
  2. 对合法 completion 取得精确 JSON 字节数并统计对象图 node 数——必须复用 `snapshotValue` 的同一次遍历：二次遍历会重复触发用户 getter 副作用，且第二次抛出会把已成功的 run 变成失败；
  3. 按三重预算决定保留、FIFO 淘汰或 `retained: false`；
  4. 将获准保留的原值引用放入 history；
  5. 根据 projection threshold 与剩余 wire budget 返回完整值、rich projection、minimal reference 或真正 output-limit；
- 保证 Inspector object group 释放后，只有 history/user binding 明确拥有的对象继续存活；
- 只有成功 run 的 completion 才入槽：exception、abort、timeout、cancellation 与 output-limit（Phase 1 期间大 completion 仍会触发）都不生成 slot；`startRun` 的 finally 对异常路径也无条件 `Runtime.releaseObjectGroup`，入槽逻辑必须位于成功分支内而非共用清理路径；partial-commit 用户 binding 语义不变；
- revoke binding leases 的顺序保持不变。

实现时必须避免把 completion store 或内部 boundary bridge 暴露为可篡改的普通对象。模型可见 `$out` 只能通过受控方法访问 store，不能取得 store map 本身。`CompletionExpiredError` 也应通过现有 error-class 安装机制冻结暴露，并纳入 reserved-name/collision 测试。

### 7.2 `src/realm/protocol.ts`

- 定义严格的 `CodeJsonValue` projected envelope；full/projected 的判别在内部 done fragment 上用模型不可见的 `projected` 标志承载，host 只在标志置位时按 envelope schema 校验并计入 projected 指标，不为 DSH 侧 `CodeRunResult` 新增顶层字段；
- 用户代码自造的 envelope 同形状对象（如 `{ "$out": 17, "use": ... }`）走普通 completion 路径：不置标志、不计入 projected 指标；伪造 handle 在 `$out(id)` 处因 id 不存在得到 `CompletionExpiredError`，不构成越权，只能误导模型自身；
- 区分：完整 completion、projected completion、invalid output、真正 output-limit；
- 保持 `OutputLedger` 按实际 wire JSON 字节计账的现有语义，并增加 projected 指标识别；
- 预算校验存在两处：worker `prepareCompletion` 比较 `remaining`，host `OutputLedger.completion` 用 `Buffer.byteLength` 重算；Phase 2 必须同步改两处，否则 host 会拒掉 worker 认为合法的 projected envelope；
- `projected` 标志与 nonce 合并为 done fragment 上的单一字段 `projected?: string`：存在性 = 是投影，值 = 本次 run 的控制通道 nonce（host 校验相等，不合法按协议违规 hard-kill）——run 消息本就携带 nonce，独立字段是同一值出现两次；
- 走查的字节估算对数字只 charge 1 字节（最坏低估约 20 倍），刻意保留：G1 关心的「上界为常数」两种写法都成立，且 node 天花板兜底（1M node × 最长合法 JSON 数字 ≈ 20 MB JSON 上界）；收紧要为每个数字付一次长度计算；
- 无值 run 的 `CodeRunResult` 不含 `value` 键（与 `value: undefined` 不同）；任何重建 result 的代码不得用展开加覆盖的方式意外引入该键；
- 固化 full/rich/minimal 降级链和最小 envelope 字节常量；最小引用 envelope 无法放入剩余预算时，仍返回明确 `output-limit`，不得发送不完整 JSON。

### 7.3 `src/realm/realm.ts` 与 `src/realm/runtime.ts`

- host 只校验和转发 projected protocol，不保存 Realm 原对象；
- 保持同 Realm 串行、generation fencing、parent-death、hard-kill 和 admission 规则；
- 新配置必须有正整数校验、默认值和公共类型；
- ordinary one-shot runtime 完全保持官方语义，completion history 只在认证 Prime Realm 路径启用。

### 7.4 Agent presentation

机制完成后删除或显著缩短 `src/policy.ts` 中要求模型主动 filter/count/slice/summary 的规则。`run_code` schema 新增说明不超过两句，只陈述能力事实，例如："Results persist across cells; `$_` holds the last result. Large results are shown truncated with a `$out(N)` handle to the full value." 不得增加输出格式教程，也不描述 `list/drop/clear` 管理面。

文档成本按层级分配：schema 承载常驻的最小能力声明；envelope 的 `use` 字段在大结果出现时就地给出可照抄的取值表达式；`CompletionExpiredError` 与 `$_` 停用提示在异常路径就地给出恢复指令。三层都不重复彼此内容，常驻 token 只花在第一层。

## 8. 兼容性与失败语义

| 情形 | 计划行为 |
| --- | --- |
| 小合法 completion | 原样返回，并进入 `$out`。 |
| 大合法 completion | cell 成功；返回有界 projection；原值按 history 预算保留。 |
| completion 超过单槽准入预算 | 返回有界 projection，`retained: false`；不误称可恢复。 |
| 非 lossless JSON completion | 保持当前 `invalid-output`，明确含成员值为 `undefined` 的对象/数组，以及 `Date` 等一切非 plain prototype（`toJSON` 从不被咨询）；用户显式 binding 若已建立仍遵循 partial commit。是否在后续阶段放宽 `undefined` 成员值须单独决策，不得在实现时顺手改。Phase 2 起校验范围以有界走查为界：准入天花板内检出的非 lossless 仍是 `invalid-output`；超出走查边界的部分不做校验——这是 G1 的必然代价（大值尾部的 bigint 不再被发现，该值成功投影）；保留物是原对象而非快照，未校验不影响 `$out(id)` 可用性，Phase 1 本就允许保留事后被改成非 JSON 的对象。 |
| projector 内部失败 | 当前 run 显式 `invalid-output` 或 internal failure，不回退为完整大输出。注意当前 `prepareCompletion` 的无差别 try/catch 把抛异常的 getter 也压成同一条 invalid-output 文案，实现时需先拆分错误分类。 |
| history 淘汰 | 只释放 runtime-owned 引用；`$out(id)` 明确报 expired。 |
| 旧 generation handle | id 全局单调不复用，旧 handle 在新 store 中缺席并抛 `CompletionExpiredError`；内部 nonce 纵深防御，绝不匹配新 generation 槽。 |
| run 外或 detached continuation 调用 `$out` | 同步拒绝，不允许跨 run 读取或释放 history。 |
| logs 吃完最终边界预算 | Phase 1/2 保持当前行为——注意当前行为是 hard-kill 并丢失整个 namespace 与全部日志，与 completion 越界只丢 completion 不对称；Phase 3 使用有界 marker 日志条目报告截断，属于 heap 契约变更而非纯展示变更，风险等级相应上调。 |
| active abort/timeout/OOM/protocol violation | 保持 hard-kill 与下一次 dispatch 的 namespace-loss notice。 |
| namespace restart | 用户 bindings 与 `$out` 一并丢失，并由现有 restart notice 报告。 |
| ordinary Session | 继续官方 one-shot Code Runtime，不出现 `$out`。 |

## 9. 分阶段实施

### Phase 0：契约测试与基准

- 固化当前小 completion、invalid output、output-limit、日志和 namespace-loss 行为；
- 增加大数组、大对象、长字符串、深层对象、重复引用和对象原地修改基准；
- 测量完整序列化、projector 和 retained reference 的 CPU、瞬时内存与峰值 heap 成本；注意当前 boundary 对大 completion 本来就先全量深拷贝加 stringify 再拒绝，projector 的 CPU 基准应聚焦增量而非全量；
- 对"保留原对象引用"与"保留现成 snapshot 副本"两种保留物分别记录 heap 曲线，含用户 binding 并存与原地修改场景，为 §5.2 的保留物定案提供数据；
- 验证按槽独立计费在典型 `$out(id)` 回流形态下的 history 淘汰行为，为 §5.2 的重复计费定案提供数据；
- 至少记录 64 MiB 级合法 completion 的捕获与投影结果，制定进入 Phase 1 的 CPU/瞬时内存/history heap 占用门槛；
- 确定 entries/bytes/nodes/projection 配置默认值，不凭经验直接写死；基准未达门槛不得进入 Phase 1。

**状态：已完成。** 契约固化见 `tests/completion-contracts.spec.ts`（19 用例全绿）；基准见 `docs/plan/phase0-bench-results.zh.md` 与 `bench/`（`bench/results/*.json` 保留入库以保证门槛数字可追溯）。门槛判定：**放行 Phase 1**——六项门槛中唯一不达标的 G1（64 MiB 单次捕获 CPU 4.7 s，目标 ≤1 s）是 `prepareCompletion` 既有的存量成本（深拷贝占 66–92%，stringify 是零头），Phase 1 只在同一遍历加计数器，实测 CPU 增量在噪声内（G5 达标）；G1 转为 Phase 2 的出口门槛，由有界早退遍历关闭。

### Phase 1：自动 completion history

- 实现 Worker module-scope generation-local store、boot nonce 与 `$out` intrinsic；
- 为所有 `$out` getter/method 增加 `leasedRunId()` 门控；
- 所有通过三重准入预算的合法 completion 自动入槽；大 completion 仍返回 output-limit 且不入槽（成功 run 才入槽的统一规则），该失败形态在 Phase 2 消失；
- 先保持模型可见小输出行为；
- 增加 FIFO 淘汰、显式 drop/clear、generation-fenced expired error；
**状态：已完成。** 实现与 41 条专项用例经契约评审两轮（有条件通过 → D1/D2/O1–O7 修复 → 增量复审通过），`npm run check` 229 passed；P17 残留面（delete+defineProperty 伪造）记录为可接受自伤。

- 按 Phase 0 硬约束实现：node 计数与准入判定内联在 `snapshotValue` 同一次遍历中——共享子图指数展开在遍历中置 `overNodeLimit` 拒绝入槽，但 Phase 1 不中断遍历（完整 JSON 仍是本阶段 wire 契约），真正的 early return 属 Phase 2；入槽采用 identity-reuse 与 §5.2 定案默认值；槽 metadata 只存 `keyCount` 等小标量，不存 key 样本——删除依据是「Phase 2 投影在捕获遍历内联生成、不复用 Phase 1 采样，不留只写字段」，而非内存占用（槽持有原对象，key 字符串本就被其属性表持有，存样本只多指针、不产生副本；这个内存模型不得再流入 Phase 2 决策）；
- 不改 logs。

### Phase 2：大 completion 自动投影

**状态：已完成。** 契约评审有条件通过后修复 A 项与 G1 三处 O(值大小) 根因（数组 `ownKeys` 在早退前物化 key、长字符串跨 Inspector 边界二次序列化、wide-object 为真枚举地板）；修后 128 MiB flat-array 0.78 ms / 0 MiB，long-string 残留 ~800 ms 为 CDP 内联第一趟（worker 拿到值之前，早退不可达，改传输策略属独立议题）；G1 复测数据见 `bench/results/g1-*.json` 与 `docs/plan/phase2-g1-exit-gate.zh.md`。

- 实现 bounded generic projector 和 full/rich/minimal/output-limit 降级链；
- 大 completion 从 `output-limit` 改为成功的 generation-fenced reference projection；
- 不为 DSH 侧 `CodeRunResult` 新增顶层字段；内部 done fragment 增加模型不可见的 `projected` 判别标志；保持 `maxOutputBytes` 最终硬上限；
- 增加 capture bytes、projection bytes、retained/evicted 等可观测字段；
- 出口门槛（承接 Phase 0 的 G1）：大 completion 路径不得构造完整 snapshot，投影与准入为有界早退遍历，64 MiB 级投影 CPU 与值大小无关（常数量级）；
- 承接 Phase 1 的已知缺口与前置约束：嵌套层 key 样本在捕获遍历内联生成投影时取得——投影本体就是内联生成，不要复用 Phase 1 存下的根对象 key（那份只写不读、无用例验证）；Phase 1 的 `overNodeLimit` 标志位在投影上线后升级为真正的 early return；捕获遍历的 key/metadata 采样不得因预算爆掉而中断——被拒绝保留的大 completion 仍必须产出投影，而重新枚举 key 已被基准排除（64 MiB wide-object 857 ms），该不变量在 Phase 1 只有代码注释守护（`CaptureStats.overNodeLimit` 文档块），因此 **Phase 2 的第一条验收用例**定为：projector 必须能为一个 `overNodeLimit`（拒绝保留）的值产出带 key 样本的 envelope——它从模型可见行为出发，同时守护「采样不因预算中断」不变量与「拒绝保留仍要投影」核心语义，比内部断言健壮；另注意早退上线后模型可见行为的边界：node 超预算但 JSON 装得下的 completion 在 Phase 1 是成功的完整返回，Phase 2 改为成功的投影返回，任何实现都不得让它退化成 invalid-output；在 §4.4 的 key 截断落地之前，槽 metadata 中的 `keys` 不得暴露进 `$out.list()`（契约已固化 20000 字符 key 合法，16 个即 320 KB，会直接撑爆输出预算）。

### Phase 3：日志投影分账

**状态：已砍掉（2026-08-24 决策）。** 日志越界 hard-kill 的现有行为存在已久、对核心目标（大结果不再失败、删除摘要提示词）无贡献，且契约评审已确认这是风险等级最高的 heap 契约变更。当前行为即终态契约（`tests/completion-contracts.spec.ts` 已钉住）；只有实际数据证明日志 storm 是真问题时才重开本阶段。以下原文保留供届时参考。

- 参考上游 stdout/stderr 截断，设计 `console.log` 有界收集；
- 通过有界 marker 日志条目明确 dropped bytes/entries，不增加 `CodeRunResult` 顶层字段；
- 保持统一合并 cap，并验证日志 storm 不掩盖 completion 状态、不劈 Unicode 代理对，也不突破 host 边界。

### Phase 4：简化模型 policy 与文档

**状态：已完成（最小形态）。** policy 的 reduce-first 规则删除，`run_code` schema 增加两句能力声明，`keyCount` 进 `$out.list()`，README 与 architecture 文档按新语义更新，`tests/code-mode.spec.ts` 5 处断言显式改写。Adopt/Adapt/Defer 记录从简（本文档即记录）。

注意（Phase 1 实现发现）：`$out.list()` 的返回值作为 cell 末尾表达式时自身也是 completion，会占槽并移动 `$_`——规则自洽，维持现状；但文案不得把 `list()` 描述成「随便看一眼」的免费操作（entries=16 下连看几次会挤掉工作集一格），无扰动读取的惯用式是 `console.log(JSON.stringify($out.list()))`。

- 删除要求模型主动归约输出的格式规则；
- 更新 `README.md`、`docs/architecture.md`、`src/policy.ts`；
- 记录与上游 IPython `Out`、snapshot/pruning 的 Adopt/Adapt/Defer 判断；
- 处置 `CompletionSlot.keyCount`（Phase 2 后仍是只写字段）：进 `$out.list()`（小整数、有界、对模型有用）或删除，二选一；
- 不在本阶段引入 TypeScript heap snapshot。

## 10. 测试矩阵

至少覆盖：

### Worker/Realm 单元测试

- 小 completion 原样返回且 `$_` 可读；falsy completion（`0/false/null/""`）也正确入槽；
- 用户显式赋值 `$_` 后停用并单次提示（Node REPL 式规则）；停用只影响 `$_`，`$out(id)` 不受影响；`const _` 与 lodash 式 `_` 用法完全不受本机制影响；
- `const/let $out`、赋值、嵌套 shadow 与不可枚举 global 的命名冲突行为固定并测试；
- 空 history 的 last/list/get、id 单调不复用、drop 未知/重复和 clear 后 expired；
- 未显式赋值的大工具结果可通过 `$out(id)` handle 再次计算；
- history 保存对象身份，后续原地修改可见；修改成非 JSON 后再次作为 completion 返回仍是 invalid-output 且 cell partial commit 保留；
- FIFO 淘汰顺序、drop/clear 幂等和 expired error；
- 用户 binding 与 history 引用互不拥有；
- 非 JSON、循环对象、bigint、function 保持 invalid-output；
- projection 的深度、节点、字符串和 UTF-8 字节预算；
- Unicode/代理对不劈开、极长 key、空数组/对象、null、对抗性形状；
- 递归深度上限只断言行为（RangeError 被现有 catch 转成 invalid-output），不断言具体深度数值（实测约 7.8k 且随栈状态波动）；
- 同输入 projection 字节级确定；用户自造 envelope 同形状对象不触发内部 `projected` 标志、不计入 projected 指标，伪造 handle 经 `$out(id)` 得到 expired error；
- full/rich/minimal/output-limit 降级链每个边界至少一项测试；
- projector 结果本身始终为 lossless JSON；
- exception/abort 不创建错误 slot；
- hard-kill 后旧 handle 全部 expired；id 跨 generation 全局单调不复用，新 generation 不从 1 重新计数，旧 handle 绝不命中新槽；queued cancel 与 Worker 中途崩溃不产生槽；
- run 外和 detached continuation 调用 `$out` 被拒；binding lease 撤销顺序不变。

### Runtime/协议测试

- projected completion 按实际 projection wire 字节记账；任意 logs + projection 组合不超过 `maxOutputBytes`；
- 最小 envelope 常量与 notice reserve 共同验证；不能放入时明确 output-limit；
- queued cancellation、active timeout、Worker exit、parent death 不泄漏 history；
- 多 Realm 隔离，同一 Realm 串行；
- ordinary one-shot session 完全无行为变化；
- 配置校验和默认值；
- maxActiveRealms/maxIdleMs 回收释放 completion references。

### 受影响的现有断言

实施时必须显式改写而不是绕过以下契约测试：

- `tests/realm-worker.spec.ts`：oversized completion 在 Prime Realm 中由 output-limit 改为成功 projection；Phase 3 的 oversized logs 改为 marker 截断；
- `tests/completion-contracts.spec.ts`（Phase 0 新增）：当前契约的集中固化点——restart notice 逐字文案、512-byte reserve 边界、`const _`/`const $out` 今天合法（`$_` 落地后 `const _` 契约保持不变，仅 `$out`/`$_` 相关用例按新契约改写）、未命名结果不可寻址等；Phase 1/2 按文件内各 `CURRENT CONTRACT` 注释显式改写对应用例，不得删除绕过；
- `tests/prime-runtime.spec.ts`：notice 断言只做包含性检查（`expectLostNamespaceNotice`），受影响较小，改动限于 notice 需新增 completion history 丢失说明的部分；
- `tests/large-tool-output.e2e.spec.ts` scenario 3：改为 generation-fenced envelope 语义；
- `tests/code-mode.spec.ts`：policy 与 run_code schema 文案；
- 对应 one-shot 测试保持原断言，证明分歧只存在于认证 Prime Realm 路径。

### 集成与打包测试

- Prime preset 中只有 Prime Session 获得 `$out`；
- Code Mode assembly/tool description 与真实语义一致；
- Session 日志只持久化 bounded projection，不把 retained raw value 写入对话；
- DSH spill、tool logging 和 artifact 行为不被复制或破坏；
- `npm run check` 全量通过，`src/` 与生成的 `lib/` 同步。

## 11. 可观测性

为验证机制确实减少 token，而不是只改变错误形式，建议记录有界指标：

- completion capture bytes；
- completion projection bytes；
- reduction ratio；
- history retained/rejected/evicted count；
- history estimated bytes 和 entries；
- projection truncated count 与 reference envelope 使用率；
- 旧 generation/expired/run-outside 拒绝计数（不含内容或身份）；
- Phase 2 后仍发生的 output-limit count；
- Phase 3 的 dropped log entries/bytes。

指标不得包含 completion 内容、凭据、原始路径或 session identity。Session 持久日志只记录 bounded metadata。承载体（Phase 2 定案）：`PersistentRealm` 上的只读计数器，经 `PrimeCodeRuntime` 的 `metrics` getter 汇总暴露，测试直接断言；不接 logger、不进 Session 日志、不上 wire，模型不可见。

## 11.5 收尾时登记的遗留议题（不阻塞，独立立项）

G1 复测（`docs/plan/phase2-g1-exit-gate.zh.md`）通过后留下的已知边界，均为既有机制、在投影器职责之外：

1. **R1**：被 G1 豁免的根 key 单次枚举，其**内存**随 key 数无界——wide-object 128 MiB / 559 万 key worker-exit、256 MiB OOM。模型自然产生的大字典会打死 worker 丢 namespace，而不是拿到 `retained: false` 投影，行为上比慢严重。
2. **R2**：字符串完成值经 CDP RemoteObject 按值内联，在捕获遍历开始前就被完整编解码一遍（64 MiB → 390 ms / 422 MiB，256 MiB worker-exit）；捕获遍历本身对字符串 O(1)（wrapped-string 0.6 ms 为证）。有实测支撑的修法：边界求值时把完成值包一层拿 objectId、main world 内解包。
3. **行为缺口**：超出天花板且带额外属性的稀疏数组，从 `invalid-output` 变为 `retained: false` 投影（数组完整性检查推迟到 `!aborted` 的代价，与 bigint 既有行为一致）——尚无用例钉住。
4. G1 文档 §5.3 的 6 条防回归门槛中 4 条已绿可固化，「wide-object 128 MiB 不死」与「long-string 峰值 ≤2×」需 R1/R2 修复后才绿。
5. identity-reuse 不省捕获 CPU（身份命中在走查之后）；将来若要回流变便宜，把身份查找挪到走查之前。

## 12. 明确不做

本计划不包括：

- 引入 Python、IPython、Jupyter、ZMQ 或 dill；
- 照搬无界 `In/Out/_N` 历史、保存 cell code 或 fork-server 4096 条 child FIFO（有界的 `$_` 最近结果 binding 除外）；
- 照搬按 stdout/stderr/result 各自 65,536 字符的 silent slice 截断；
- 对整个 TypeScript heap 做 snapshot/restore；
- 在 DSH compaction 时遍历并删除用户 lexical bindings，或复制上游 prune 播报文案；
- 自动把任意 completion 写入工作区文件或 continual state；
- 为每种 DSH tool 在 Realm 中复制专用 summarizer；
- 改写 DSH Session、Agent Loop、Subagent、Jobs、Goal 或 spill artifact 所有权；
- 改变 ordinary one-shot Code Mode 的官方语义。

## 13. 验收标准

计划实施完成需同时满足：

1. 模型直接把大型合法工具结果作为 cell 最终表达式时，cell 成功且模型投影严格有界；
2. 未显式赋值的原始结果可以在后续 cell 通过 runtime reference 继续计算；
3. 小结果的现有模型可见形状保持兼容；
4. 不依赖“请先摘要/切片”的系统提示规则；
5. history 淘汰不会删除用户 binding，hard-kill 后不会留下跨 generation 假引用；
6. output、heap、history 三类预算边界清晰且有回归测试；
7. Prime 与 ordinary session 路由隔离不变，身份握手失败继续 fail closed；
8. 文档、policy、`src/`、`lib/` 与测试同步；
9. 完整验证 `npm run check` 通过；
10. 通过主动评测的 Prime 会话日志（如 Harbor 装置构造的大工具输出场景；真实会话可作补充）证明大 completion 的模型投影显著缩小，并且没有增加重复工具调用率或任务失败率；
11. hard-kill 后任何旧 generation handle 都得到明确 expired error，id 全局单调不复用，绝不命中新 generation 任意槽；
12. 最小 envelope 常量和 full/rich/minimal/output-limit 降级链有边界回归，任意 logs + projection 的 wire 字节不超过 `maxOutputBytes`；
13. `$out` 在 run 外调用被拒，detached continuation 不能 get/drop/clear；
14. Phase 0 对至少 64 MiB 级 completion 记录 CPU、瞬时内存和 history 峰值 heap 门槛，未达标不得进入 Phase 1；
15. “受影响的现有断言”所列测试全部按新 Prime 契约改写，one-shot 对照不变，`src/` 与 `lib/` 同步；
16. 主动评测会话中 reference envelope 实际使用率大于零，projection 字节中位数下降，重复工具调用率与失败率不上升；该证据由评测装置主动构造，不设只能上线后闭合的实测门槛。
