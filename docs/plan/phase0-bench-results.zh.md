# Phase 0 基准测量结果

> 对应计划：`docs/plan/completion-history-output-projection.zh.md` §5.2、§9 Phase 0、§13 验收 #14
> 范围：Phase 0 的**基准测量**半边（契约测试由另一路负责）
> 脚本目录：`bench/`（不进 `tests/`，不改 `src/` 与 `lib/`）

## 1. 环境

| 项 | 值 |
| --- | --- |
| Node | v24.18.0 |
| npm | 11.16.0 |
| OS | Windows 11 Home China 10.0.26200 (win32 x64) |
| CPU | Intel(R) Core(TM) Ultra 9 285K，24 逻辑核 |
| 物理内存 | 68,073,525,248 B（63.4 GiB） |
| 测量日期 | 2026-08-24 |

被测代码基线（`git rev-parse HEAD` = `cb10ef23`）中与本测量直接相关的既有默认值：

| 配置 | 默认值 | 位置 |
| --- | --- | --- |
| `maxOutputBytes` | 67,108,864 B（64 MiB） | `src/runtime.ts:43` |
| `maxOldGenerationSizeMb` | 512 | `src/runtime.ts:44` |

这两个值决定了整个测量的坐标系：**64 MiB completion 在当前实现里是一个合法、会被完整送过 wire 的值**，而承载它的 Worker 只有 512 MiB 老生代。

## 2. 方法

### 2.1 被测路径的复刻

`bench/lib/snapshot.mjs` 逐行复刻 `src/realm/realm-worker.ts` 的边界路径，并保留其 captured-primitive / `Reflect.apply` 间接层（该间接层本身就是被测 CPU 成本的一部分）：

| 复刻函数 | 来源 |
| --- | --- |
| captured primitives | `realm-worker.ts:25-59` |
| `snapshotJson` | `realm-worker.ts:634-636` |
| `snapshotValue` | `realm-worker.ts:638-676` |
| `prepareCompletion` 的字节计量 | `realm-worker.ts:693-703` |

`snapshotValueCounting` 是同一遍历再加一个 node 计数器，用于测量计划 §7.1 第 2 步"在同一次有界遍历中统计 node 数"的增量成本。

### 2.2 测量手段

- **CPU**：`performance.now()`，取多次重复的 **min**（最干净的信号）与 median；`bench/counting-delta.mjs` 交错运行 plain / counting 两个变体以消除堆状态噪声。
- **瞬时内存**：`bench/lib/rss-sampler.mjs` 用一个 worker thread 每 2 ms 轮询 `process.memoryUsage.rss()`。主线程在同步的 snapshot + stringify 期间被阻塞、无法自测峰值，而 RSS 是进程级的，worker 的事件循环仍在跑，因此能采到真实峰值。
- **驻留 heap**：`globalThis.gc()` 连续两次后读 `heapUsed()`（`bench/lib/measure.mjs` 的 `settledHeap`）。
- **进程隔离**：每个 (shape, size) 用例、每个 heap-gate 用例、每个 node-density shape 都跑在独立子进程里。共享进程时，上一轮保留的数百 MiB 图会让下一轮的基线读数不稳，甚至出现负的 heap delta。

### 2.3 形状与规模

`bench/lib/fixtures.mjs`，全部由固定种子的 mulberry32 生成，重复运行字节数与 node 数完全一致。

| shape | 说明 | 覆盖的计划要求 |
| --- | --- | --- |
| `flat-array` | 9 位整数数组，约 10 B/元素 | 大数组 |
| `record-array` | 小记录数组（4 字段），约 66 B/记录 | 大数组 + 典型工具输出 |
| `wide-object` | 单层多 key 对象，约 24 B/条目 | 大对象 |
| `long-string` | 单条长 ASCII 字符串 | 长字符串 |
| `deep-nested` | 深度 1000 的左脊链 + 叶数组 | 深层嵌套 |
| `sharedDag` | 同一子对象被多路复用的 DAG | 重复引用 |

规模：1 / 8 / 16 / 64 MiB（按目标 JSON 字节数）。

### 2.4 复现命令

```powershell
# 3.1 当前 boundary 全量捕获成本矩阵（每用例独立子进程）
node bench/run-capture.mjs --sizes 1,8,16,64 --repeat 3 --heap 8192

# 3.2 node 计数增量（交错 A/B，取 min）
node --expose-gc --max-old-space-size=8192 bench/counting-delta.mjs --sizes 1,8,16,64 --repeat 7

# 3.3 / 3.4 保留物 heap 曲线与原地修改漂移（逐 shape）
foreach ($s in @('flat-array','record-array','wide-object','long-string','deep-nested')) {
  node --expose-gc --max-old-space-size=10240 bench/retention-bench.mjs --shape $s --unit-mib 8 --slots 8
}

# 3.5 节点密度（每 shape 独立子进程）
node bench/node-density-bench.mjs --mib 16

# 3.6 FIFO 回流模拟（纯模拟，秒级）
node bench/fifo-bench.mjs

# 3.7 有界投影成本与 envelope 字节
node --expose-gc --max-old-space-size=8192 bench/projection-bench.mjs
node --expose-gc --max-old-space-size=8192 bench/key-iteration-bench.mjs

# 3.8 对抗形状：共享引用放大与递归深度
node --expose-gc --max-old-space-size=4096 bench/adversarial-bench.mjs

# 3.9 受限 heap 门槛
node bench/heap-gate.mjs --heaps 512,768,1024 --mib 64
node bench/history-gate.mjs --sweep --heap 512
```

原始数据落在 `bench/results/*.json`（`capture.json`、`counting-delta.json`、`retention-*.json`、`node-density.json`、`fifo.json`、`projection.json`、`key-iteration.json`、`adversarial.json`、`heap-gate.json`、`history-gate.json`）。

## 3. 原始数据

### 3.1 当前 boundary 全量深拷贝 + stringify（存量成本基线）

每格取 3 次重复的中位数。`snapshot` = `snapshotJson` 深拷贝；`stringify` = `JSON.stringify`；`峰值 RSSΔ` = 同步段内 worker 采样到的进程 RSS 峰值减去起始 RSS。

| shape | MiB | JSON MiB | 原对象 live heap | snapshot 副本 heap | snapshot ms | stringify ms | 合计 ms | nodes | 峰值 RSSΔ | 瞬时 heapΔ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| flat-array | 1 | 1.00 | 0.81 | 0.87 | 10.9 | 2.1 | 13.2 | 104,858 | 5.3 | 4.7 |
| record-array | 1 | 0.96 | 1.62 | 4.41 | 9.1 | 3.5 | 12.8 | 79,436 | 0 | 10.5 |
| wide-object | 1 | 0.83 | 2.51 | 1.49 | 10.2 | 6.1 | 16.5 | 43,691 | 4.6 | 5.5 |
| long-string | 1 | 1.00 | 1.01 | 0 | 0.002 | 0.8 | 1.1 | 1 | 0 | 1.0 |
| deep-nested | 1 | 1.01 | 0.89 | 1.28 | 5.5 | 2.8 | 8.7 | 106,000 | 0 | 3.8 |
| flat-array | 8 | 8.00 | 6.41 | 6.63 | 105.0 | 17.4 | 124.3 | 838,861 | 78.3 | 87.1 |
| record-array | 8 | 7.70 | 12.80 | 35.24 | 72.2 | 27.0 | 102.4 | 635,501 | 73.8 | 59.6 |
| wide-object | 8 | 6.67 | 20.01 | 12.00 | 155.4 | 89.9 | 247.3 | 349,526 | 48.7 | 39.7 |
| long-string | 8 | 8.00 | 8.01 | 0 | 0.002 | 6.9 | 8.9 | 1 | 0 | 8.0 |
| deep-nested | 8 | 8.01 | 6.49 | 6.69 | 34.7 | 19.9 | 56.5 | 840,000 | 33.7 | 19.5 |
| flat-array | 16 | 16.00 | 12.81 | 14.93 | 271.4 | 34.1 | 308.6 | 1,677,722 | 119.6 | 88.1 |
| record-array | 16 | 15.40 | 25.59 | 69.84 | 128.1 | 53.7 | 185.5 | 1,271,001 | 23.7 | 126.1 |
| wide-object | 16 | 13.33 | 40.01 | 24.00 | 362.9 | 195.3 | 565.4 | 699,051 | 114.0 | 90.5 |
| long-string | 16 | 16.00 | 16.01 | 0 | 0.002 | 13.3 | 17.5 | 1 | 16.3 | 16.0 |
| deep-nested | 16 | 16.01 | 12.89 | 15.10 | 72.2 | 38.4 | 114.5 | 1,679,000 | 81.5 | 42.7 |
| **flat-array** | **64** | **64.00** | **51.21** | **75.56** | **1989.3** | **160.2** | **2166.0** | **6,710,887** | **551.6** | **663.6** |
| **record-array** | **64** | **61.59** | **102.31** | **281.46** | **527.0** | **226.0** | **768.5** | **5,084,001** | **129.5** | **395.2** |
| **wide-object** | **64** | **53.33** | **160.01** | **96.00** | **3132.7** | **1417.5** | **4572.4** | **2,796,203** | **395.4** | **347.6** |
| **long-string** | **64** | **64.00** | **64.01** | **0** | **0.002** | **52.7** | **67.7** | **1** | **84.4** | **64.0** |
| **deep-nested** | **64** | **64.01** | **51.29** | **76.65** | **326.7** | **157.1** | **497.9** | **6,712,000** | **141.8** | **141.7** |

（heap / RSS 列单位均为 MiB。）

三个要点：

1. **深拷贝支配一切**。`snapshotValue` 花掉总时间的 66%–92%，`JSON.stringify` 只是零头。计划里"projector 的 CPU 基准应聚焦增量而非全量"是对的，但方向要反过来看：真正贵的是**深拷贝本身**，不是序列化。
2. **64 MiB 的同步阻塞在秒级**：`wide-object` 4.57 s，`flat-array` 2.17 s。这段时间 Worker 完全被占住。
3. **`long-string` 几乎免费**：`snapshotValue` 对字符串直接返回原引用（`realm-worker.ts:641`），没有拷贝。

### 3.2 node 计数的增量 CPU 成本

`bench/counting-delta.mjs`，交错 A/B，7 次重复取 min。

| shape | MiB | nodes | plain min ms | counting min ms | Δ(min) | Δ(median) |
| --- | --- | --- | --- | --- | --- | --- |
| flat-array | 1 | 104,858 | 7.678 | 7.531 | −1.9% | +30.9% |
| record-array | 1 | 79,436 | 5.092 | 5.124 | +0.6% | +1.3% |
| wide-object | 1 | 43,691 | 8.116 | 8.138 | +0.3% | +1.4% |
| long-string | 1 | 1 | 0.001 | 0.001 | +44.4% | +60.0% |
| deep-nested | 1 | 106,000 | 3.038 | 3.136 | +3.2% | +1.2% |
| flat-array | 8 | 838,861 | 78.567 | 79.718 | +1.5% | +1.5% |
| record-array | 8 | 635,501 | 54.271 | 54.652 | +0.7% | +0.4% |
| wide-object | 8 | 349,526 | 187.091 | 196.123 | +4.8% | +5.6% |
| long-string | 8 | 1 | 0.003 | 0.004 | +53.6% | +45.5% |
| deep-nested | 8 | 840,000 | 36.177 | 36.786 | +1.7% | +1.0% |
| flat-array | 16 | 1,677,722 | 319.013 | 309.648 | −2.9% | −0.5% |
| record-array | 16 | 1,271,001 | 127.401 | 136.943 | +7.5% | −1.0% |
| wide-object | 16 | 699,051 | 519.966 | 516.800 | −0.6% | +2.7% |
| long-string | 16 | 1 | 0.003 | 0.005 | +56.7% | +41.2% |
| deep-nested | 16 | 1,679,000 | 79.127 | 78.847 | −0.4% | +1.5% |
| flat-array | 64 | 6,710,887 | 2232.574 | 2145.679 | −3.9% | −0.7% |
| record-array | 64 | 5,084,001 | 677.823 | 666.290 | −1.7% | +3.1% |
| wide-object | 64 | 2,796,203 | 3389.676 | 3337.960 | −1.5% | −0.7% |
| long-string | 64 | 1 | 0.004 | 0.005 | +9.8% | +28.9% |
| deep-nested | 64 | 6,712,000 | 428.875 | 428.884 | 0.0% | +5.4% |

**结论：node 计数的增量在噪声以内。** 除 `long-string` 外，所有测点的 Δ 都在 ±8% 范围内且正负交替（多次为负值，说明信号小于测量抖动）。`long-string` 的 +44%~+57% 是 1 个 node、绝对值 1–2 μs 的比值放大，无实际意义。**在既有遍历里附加 node 计数不需要额外预算。**

### 3.3 保留物 heap 曲线：身份 vs 快照

`bench/retention-bench.mjs`，每 shape 8 个槽 × 8 MiB。`bound` = 用户 binding 同时持有原对象；`unbound` = completion 是临时值，只有 history 持有。表内为 8 槽合计驻留 heap（MiB）。

| shape | identity / bound | identity / unbound | snapshot / bound | snapshot / unbound |
| --- | --- | --- | --- | --- |
| flat-array | 57.86 | 57.85 | 104.27 | 53.07 |
| record-array | 134.19 | 134.17 | **380.91** | **318.85** |
| wide-object | 116.02 | 116.01 | 200.00 | 104.00 |
| long-string | 64.01 | 64.01 | 64.00 | 64.00 |
| deep-nested | 58.55 | 58.52 | 105.35 | 53.53 |

读法：

- **identity 的 bound / unbound 两列必然相同**——history 自己就持有原对象，用户是否另持一份不改变总量。这正是"避免与用户 binding 双持同一数据时内存翻倍"想要的效果。
- **有用户 binding 时，snapshot 永远更贵**：1.80×（flat-array）、2.84×（record-array）、1.72×（wide-object）、1.80×（deep-nested）。
- **即使没有用户 binding，snapshot 也不一定更省**。`record-array`（最贴近真实工具输出的形状）下 snapshot 是 318.85 MiB vs identity 134.17 MiB，**贵 2.38 倍**。原因是 `snapshotValue` 用 `capturedObjectCreate(null)`（`realm-worker.ts:663`）构造 null-prototype 对象，V8 把它们放进字典模式，比原字面量对象的隐藏类布局重得多。
- 只有 `flat-array` / `wide-object` / `deep-nested` 的 unbound 场景下 snapshot 略省（约 8%–10%），代价是 bound 场景翻倍。

**这推翻了计划 §5.2 的一个前提**："该副本本就是现成产物，保留它只花内存不花 CPU"——内存不是"只花一点"，而是在最贴近真实工具输出的形状上比原对象贵 2.4–2.8 倍。

### 3.4 identity 保留物的 capture bytes 漂移

同脚本的 drift 部分：入槽后原地修改，比较 `serializedBytesAtCapture` 与当下真实字节数。

| shape | 修改 | capture bytes | identity 当下字节 | 漂移比 | 仍是 lossless JSON | snapshot 漂移比 |
| --- | --- | --- | --- | --- | --- | --- |
| flat-array | 追加约 10× | 8,388,601 | 83,886,071 | **10.00×** | 是 | 1.00× |
| flat-array | 截断到 1 元素 | 8,388,601 | 11 | **0.000×** | 是 | 1.00× |
| flat-array | 改成非 JSON | 8,388,601 | — | — | **否** | 1.00× |
| record-array | 追加约 10× | 8,072,455 | 83,569,925 | **10.35×** | 是 | 1.00× |
| record-array | 截断到 1 元素 | 8,072,455 | 64 | **0.000×** | 是 | 1.00× |
| record-array | 改成非 JSON | 8,072,455 | — | — | **否** | 1.00× |
| wide-object | 追加约 10× | 6,990,501 | 82,487,983 | **11.80×** | 是 | 1.00× |
| wide-object | 删除除首 key 外全部 | 6,990,501 | 21 | **0.000×** | 是 | 1.00× |
| wide-object | 改成非 JSON | 6,990,501 | — | — | **否** | 1.00× |
| deep-nested | 追加约 10× | 8,394,995 | 83,892,477 | **9.99×** | 是 | 1.00× |
| deep-nested | 截断 | 8,394,995 | 8,386,606 | 1.00× | 是 | 1.00× |
| long-string | 全部三项 | — | — | — | — | 字符串是原始值，无法原地修改，identity 在该形状下不存在漂移风险 |

**identity 的记账失真是真的、而且是量级级别的**：向上可达 11.8×，向下可到 0。snapshot 副本则恒为 1.00×。这一项是 snapshot 唯一真正胜出的地方。见 §4.2 的权衡。

### 3.5 节点密度：字节预算为什么单独不够

`bench/node-density-bench.mjs --mib 16`，每 shape 独立进程。全部是**合法的 lossless JSON**。

| 形状 | 元素数 | JSON | nodes | 原对象 live heap | snapshot 副本 heap | heap / JSON 字节 | heap / node |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `[0,0,0,…]` | 8,388,608 | 16 MiB | 8,388,609 | 64.0 MiB | 91.6 MiB | 4.00× | 8 B |
| `["","",…]` | 5,592,405 | 16 MiB | 5,592,406 | 42.7 MiB | 66.4 MiB | 2.67× | 8 B |
| `[null,null,…]` | 3,355,443 | 16 MiB | 3,355,444 | 25.6 MiB | 49.6 MiB | 1.60× | 8 B |
| `[[],[],…]` | 5,592,405 | 16 MiB | 5,592,406 | 213.3 MiB | 237.1 MiB | 13.33× | 40 B |
| **`[{},{},…]`** | **5,592,405** | **16 MiB** | **5,592,406** | **341.3 MiB** | **1047.7 MiB** | **21.33×** | **64 B** |
| `[{a:0},…]` | 1,864,135 | 14.2 MiB | 3,728,271 | 71.1 MiB | 356.3 MiB | 5.00× | 20 B |

**16 MiB 的 JSON 可以对应 341 MiB 的活对象图**（`[{},{},…]`），而它的 snapshot 副本要 **1048 MiB**——在 512 MiB 的 Worker 老生代里直接是致命的。

这两条由此确立：

- `maxCompletionHistoryEstimatedBytes` **不能**单独约束 heap，最坏比值是 21.3×（identity）/ 65.5×（snapshot）。
- `maxCompletionHistoryNodes` 是真正的 heap 约束项。最坏每 node 成本：identity 64 B，snapshot 187 B。

### 3.6 FIFO 按槽计费在回流形态下的行为

`bench/fifo-bench.mjs`，纯模拟。三种计费策略：

- `per-slot`：每次入槽都新开一格并全额计费（计划 §5.2 的首版方案）；
- `identity-dedup`：重复对象新开一格但不重复计费；
- `identity-reuse`：重复对象**不开新格**，直接返回它已有的 id，保持其原有 FIFO 位置。

`watched` = 模型正在使用的那个 id。`survived` = 该 id 仍能用 `$out(id)` 取到。

预算 entries=16 / bytes=64MiB / nodes=8M：

| trace | 计费 | live 槽 | 不同对象 | 淘汰次数 | watched id 存活 |
| --- | --- | --- | --- | --- | --- |
| explore-then-recirculate（12×2MiB，然后 `$out(3)`×8） | per-slot | 16 | 9 | 4 | **否** |
| | identity-dedup | 16 | 9 | 4 | **否** |
| | identity-reuse | 12 | 12 | 0 | 是 |
| echo-loop（1×8MiB 在 10 个小结果之间回显） | per-slot | 14 | 8 | 7 | **否** |
| | identity-dedup | 16 | 9 | 5 | **否** |
| | identity-reuse | 11 | 11 | 0 | 是 |
| single-heavy-repeat（24MiB 入槽 3 次） | per-slot | 2 | 1 | 2 | **否** |
| | identity-dedup | 4 | 2 | 0 | 是 |
| | identity-reuse | 2 | 2 | 0 | 是 |
| filter-chain（16MiB 源 + 10 个派生切片） | 三者相同 | 11 | 11 | 0 | 是 |

预算 entries=32 / bytes=64MiB / nodes=8M：

| trace | 计费 | live 槽 | 不同对象 | 淘汰 | watched 存活 |
| --- | --- | --- | --- | --- | --- |
| explore-then-recirculate | per-slot | 20 | 12 | 0 | 是 |
| | identity-reuse | 12 | 12 | 0 | 是 |
| echo-loop | per-slot | 14 | 8 | 7 | **否** |
| | identity-dedup | 21 | 11 | 0 | 是 |
| | identity-reuse | 11 | 11 | 0 | 是 |
| single-heavy-repeat | per-slot | 2 | 1 | 2 | **否** |
| | identity-reuse | 2 | 2 | 0 | 是 |

**按槽独立计费会被刷穿，而且是以最糟的方式刷穿。** 三个具体失效：

1. `single-heavy-repeat`：一个占预算 3/4 的结果被再次作为末尾表达式返回，第二次入槽把第一次的槽挤掉。模型手里的 `$out(id)` 直接 expired——**尽管那个对象就在 store 里，只是换了个 id**。模拟里 `watchedObjectStillReachable=true` 而 `watchedIdSurvived=false`，这正是最坏的用户体验：值还在，句柄死了。
2. `echo-loop`：8 MiB 结果在 10 个小结果之间回显 10 次，per-slot 下淘汰 7 次、只剩 8 个不同对象；identity-reuse 下淘汰 0 次、11 个不同对象全在。
3. `explore-then-recirculate` 在 entries=16 下，**`identity-dedup` 救不了**——它只免了字节，没免槽位，20 次 push 仍然吃满 16 格。只有 `identity-reuse`（不开新格）能救。

`filter-chain`（每次派生新对象）三种策略完全一致，说明 identity 处理不会伤害正常的链式使用。

### 3.7 有界投影的成本与 envelope 字节

`bench/projection-bench.mjs`，投影限制：depth 4 / array sample 8 / object keys 16 / string chars 256 / nodes 512。

| shape | MiB | capture bytes | rich 投影字节 | minimal 字节 | 投影 min ms | 缩减比 |
| --- | --- | --- | --- | --- | --- | --- |
| flat-array | 1 | 1,048,571 | 265 | 94 | 0.003 | 3,957× |
| record-array | 1 | 1,009,028 | 982 | 94 | 0.004 | 1,028× |
| wide-object | 1 | 873,801 | 503 | 94 | **3.569** | 1,737× |
| long-string | 1 | 1,048,576 | 443 | 95 | 0.001 | 2,367× |
| deep-nested | 1 | 1,054,995 | 792 | 95 | 0.003 | 1,332× |
| flat-array | 64 | 67,108,861 | 267 | 95 | 0.001 | 251,344× |
| record-array | 64 | 64,581,137 | 985 | 95 | 0.003 | 65,565× |
| wide-object | 64 | 55,924,041 | 507 | 96 | **787.468** | 110,304× |
| long-string | 64 | 67,108,864 | 445 | 96 | 0.001 | 150,806× |
| deep-nested | 64 | 67,114,995 | 797 | 96 | 0.003 | 84,210× |

- **rich envelope 实测 265–985 B，minimal reference envelope 86–119 B**（含最坏情况：9 位 id + `Number.MAX_SAFE_INTEGER` 字节数 + `retained:false`）。
- 投影本身对除 `wide-object` 外所有形状都是 **O(预算)**，与值大小无关（64 MiB 上 0.001–0.003 ms）。
- **`wide-object` 是唯一的例外，787 ms**。原因是 `Object.keys(value)` 在取前 16 个 key 之前先物化了全部 233 万个 key。

`bench/key-iteration-bench.mjs` 验证了这条路没有便宜的替代：

| wide-object | `Object.keys().slice(0,16)` | `Reflect.ownKeys().slice(0,16)` | `for..of Object.keys()` + break | `for..in` + break |
| --- | --- | --- | --- | --- |
| 1 MiB | 3.345 ms | 5.332 ms | 3.453 ms | 3.576 ms |
| 16 MiB | 113.815 ms | 235.747 ms | 105.481 ms | 133.134 ms |
| 64 MiB | 857.034 ms | 1951.838 ms | 818.524 ms | 819.816 ms |

`for..in` + 早退**没有帮助**：字典模式对象的枚举缓存仍然要整体物化。`Reflect.ownKeys` 比 `Object.keys` 还慢 2.3×。**结论：不存在"只取前 16 个 key"的廉价路径，key 枚举必须复用捕获遍历那一次，绝不能在 projector 里重来一遍。**

### 3.8 对抗形状

#### 共享引用放大

`snapshotValue` 的 `seen` 是**路径集合**——退出时 `capturedSetDelete`（`realm-worker.ts:674`）。它只拒绝环，不识别共享。因此一个 DAG 的每条路径都会被独立展开。

`bench/adversarial-bench.mjs`（live 图只有几 KiB，远低于 GC 测量噪声，故用节点数而非称重表达）：

| DAG | live nodes | snapshot nodes | 放大 | JSON 字节 | snapshot ms | stringify ms |
| --- | --- | --- | --- | --- | --- | --- |
| fanout=2, levels=8, leaf 1 KiB | 112 | 26,879 | 240× | 267,763 | 2.1 | 1.0 |
| fanout=2, levels=14, leaf 1 KiB | 118 | 1,720,319 | 14,579× | 17,137,651 | 79.4 | 45.7 |
| **fanout=2, levels=18, leaf 1 KiB** | **122** | **27,525,119** | **225,616×** | **274,202,611** | **1082.4** | **738.1** |
| fanout=4, levels=6, leaf 4 KiB | 417 | 1,684,821 | 4,040× | 16,840,013 | 58.2 | 44.6 |
| **fanout=8, levels=4, leaf 16 KiB** | **1,644** | **6,718,025** | **4,086×** | **67,174,393** | **226.4** | **170.2** |

一段十几行的普通代码——建一个对象，让 8 个字段都指向它，重复 4 层——**live heap 只有几 KiB，却会在边界上产生 6700 万节点、67 MiB JSON**。levels=18 的版本产生 **274 MB JSON、2750 万节点、1.82 s**。

这在**当前实现里就已经存在**，不是本计划引入的。当前 `prepareCompletion` 先全量深拷贝加 stringify、再拿字节数去比 `remaining`——放大已经发生完了才开始判断。

**因此：任何 bytes / nodes 预算都必须在遍历过程中即时判定并早退，不能等遍历结束后再算。**

#### 递归深度

二分探测 `snapshotValue` 在默认栈上的极限：**约 7,800 层**（两次独立运行分别得到 7,803 / 7,804 和 7,797 / 7,798 的通过/失败边界，随栈状态小幅波动）。超出抛 `RangeError`，被 `prepareCompletion` 的 `catch` 转成 `invalid-output`（`realm-worker.ts:698-700`），所以不会崩。契约测试应断言"深层嵌套得到 `invalid-output` 而非进程崩溃"，**不要断言具体深度数值**——它不稳定。projector 的 `maxDepth` 必须远低于它（建议 4，相差三个数量级）。

### 3.9 受限 heap 门槛

#### 单次 64 MiB 捕获（`bench/heap-gate.mjs`）

单个 fixture、单次捕获、不保留任何东西——一个真实 cell 的形状。

| heap 上限 | shape | 结果 | 合计 ms | 峰值 RSSΔ | 进程 maxRSS |
| --- | --- | --- | --- | --- | --- |
| **512 MiB（出厂默认）** | flat-array | ok | **2142.2** | 677.0 MiB | 823.1 MiB |
| | record-array | ok | 844.7 | 493.7 MiB | 743.7 MiB |
| | wide-object | ok | **4705.7** | 298.2 MiB | 611.8 MiB |
| | long-string | ok | 70.4 | 106.2 MiB | 368.1 MiB |
| | deep-nested | ok | 546.2 | 261.1 MiB | 490.8 MiB |
| 768 MiB | flat-array | ok | 2095.9 | 725.2 MiB | 869.8 MiB |
| | wide-object | ok | 5064.7 | 343.4 MiB | 657.1 MiB |
| 1024 MiB | flat-array | ok | 2347.8 | 841.2 MiB | 986.8 MiB |
| | wide-object | ok | 5112.3 | 436.9 MiB | 761.9 MiB |

**单次 64 MiB 捕获在 512 MiB 老生代下不会 OOM**——RSS 冲到 611–823 MiB，但那部分主要在 large-object space 和外部字符串里，GC 能顶住。真正的问题是 CPU：**2.1–4.7 秒的同步阻塞**。

#### history 装满 + 再来一次捕获（`bench/history-gate.mjs`）

这才是 Phase 1 之后的真实条件。保留物用 identity（history 是唯一持有者，最保守的一侧），条目用 `record-array`。heap 上限固定 512 MiB。

| history 字节预算 | 条目数 | history 驻留 heap | 新到 completion | 结果 | 捕获 ms | 峰值 RSS | 捕获后 heap |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 16 MiB | 4 | 24.6 MiB | 16 MiB | ok | 219.1 | 342.9 MiB | 164.0 MiB |
| 16 MiB | 4 | 24.5 MiB | 64 MiB | ok | 864.3 | 733.8 MiB | 526.6 MiB |
| **32 MiB** | **8** | **47.9 MiB** | **16 MiB** | **ok** | **190.3** | **375.3 MiB** | **192.1 MiB** |
| **32 MiB** | **8** | **47.9 MiB** | **64 MiB** | **ok** | **970.5** | **744.9 MiB** | **496.9 MiB** |
| 64 MiB | 16 | 95.4 MiB | 16 MiB | ok | 183.7 | 422.4 MiB | 232.4 MiB |
| 64 MiB | 16 | 95.4 MiB | 64 MiB | ok（贴边） | 1226.9 | 687.4 MiB | **552.9 MiB** |
| 128 MiB | 33 | 193.9 MiB | 16 MiB | ok | 193.0 | 548.7 MiB | 334.5 MiB |
| **128 MiB** | **33** | **193.9 MiB** | **64 MiB** | **OOM** | — | — | Mark-Compact 505/514 MB 后 allocation failed |
| 256 MiB | 66 | 389.6 MiB | 16 MiB | ok | 530.3 | 690.6 MiB | 510.9 MiB |
| **256 MiB** | **66** | **389.6 MiB** | **64 MiB** | **OOM** | — | — | Mark-Compact 505/508 MB 后 allocation failed |

**这是本次基准最关键的一张表。** 在出厂的 512 MiB 老生代下：

- history 字节预算 **≥128 MiB 时，一个 64 MiB completion 到达就会 OOM**——即 Worker 硬崩、namespace 丢失。
- 64 MiB 预算能活但贴边（捕获后 heap 552.9 MiB，全靠 GC 压着）。
- **32 MiB 预算有真实余量**（捕获后 496.9 MiB，峰值 744.9 MiB RSS）。
- `record-array` 的 heap / capture-bytes 实测约 **1.5×**（24.6/16、47.9/32、95.4/64、193.9/128），与 §3.1 的 1.66× 一致。

## 4. 结论与定案建议

### 4.1 配置默认值

| 配置 | 建议默认值 | 依据 |
| --- | --- | --- |
| `maxCompletionHistoryEntries` | **16** | §3.6：entries=16 在三种回流 trace 下配合 identity-reuse 全部保住 watched id 且零淘汰；entries=8 在 explore 型 trace 下不够（12 个不同结果只剩 8）。16 个句柄 `$out(1..16)` 也是模型能实际用上的工作集上限。 |
| `maxCompletionHistoryEstimatedBytes` | **33,554,432（32 MiB）** | §3.9：512 MiB 老生代下，128 MiB 预算 + 64 MiB 到达 = OOM；64 MiB 贴边（552.9 MiB）；32 MiB 有余量（496.9 MiB）。32 MiB × 实测 1.5× heap 比 ≈ 48 MiB 驻留，约为 `maxOldGenerationSizeMb` 的 9.4%，符合计划 §5.2"必须保守且显著低于 `maxOldGenerationSizeMb`"。 |
| `maxCompletionHistoryNodes` | **1,000,000** | §3.5：identity 保留物最坏每 node 64 B（`[{},{},…]`）。1M × 64 B = 64 MiB，与字节预算推出的 48 MiB 同量级，两者互为封顶。若只设字节预算，16 MiB 的 JSON 可带进 341 MiB heap（21.3×），字节预算形同虚设。对真实数据 1M nodes ≈ 9.5 MiB（flat-array）/ 12.6 MiB（record-array）/ 19 MiB（wide-object）的 JSON，够放几十个常规工具结果。 |
| `maxCompletionProjectionBytes` | **4,096** | §3.7：实测 rich envelope 265–985 B，minimal reference envelope 86–119 B。4 KiB 给 4× 余量，足以在不重设计的前提下放宽投影限制；相对 64 MiB 的 `maxOutputBytes` 可忽略，相对一个收紧到 64 KiB 的 `maxOutputBytes` 也只占 6%。 |

配套的 projector 硬限制（实测在此组合下 envelope ≤ 985 B）：`maxDepth=4`、`maxArraySample=8`、`maxObjectKeys=16`、`maxStringChars=256`、`maxProjectionNodes=512`。最小 envelope 常量建议取 **128 B**（实测最坏 119 B，向上取整到 2 的幂）。

**额外建议（超出计划列出的四项）**：加一个 `maxCompletionHistoryEntryBytes`，默认 **8 MiB**（= 总预算的 1/4）。否则单个 32 MiB 的结果可以独占整个字节预算并清空所有历史槽。上游 IPython 的比例是单变量 16 MiB / 总量 256 MiB（1/16），本项目取 1/4 已经比它宽松。

### 4.2 保留物：身份还是快照

**定案：保留原对象引用（identity）。**

数据支持：

| 维度 | identity | snapshot |
| --- | --- | --- |
| 与用户 binding 并存时的 heap | 基准（1.00×） | **1.72×–2.84×** |
| 无用户 binding 时的 heap（record-array） | 基准 | **2.38×** |
| 无用户 binding 时的 heap（flat/wide/deep） | 基准 | 0.90×–0.92×（略省） |
| 最坏形状 `[{},{},…]` 16 MiB JSON | 341 MiB | **1048 MiB** |
| 最坏每 node heap | 64 B | **187 B** |
| capture bytes 准确性 | **漂移 0×–11.8×** | 恒为 1.00× |
| CPU | 0（副本本来就要构造，但可以立即丢弃） | 0 |

snapshot 只在"capture bytes 永远准确"这一项上胜出，而它在最贴近真实工具输出的 `record-array` 上、以及最坏的 `[{},{},…]` 上分别贵 2.4× 和 3.1×。在 512 MiB 的老生代里，这个倍数直接决定会不会 OOM（§3.9：193.9 MiB 的 history 就够触发 OOM，snapshot 策略下同样的字节预算会更早到达该点）。

对 identity 漂移的处置（不是改保留物，而是承认记账性质）：

1. 字段名保持计划里的 `serializedBytesAtCapture`——这个名字已经是诚实的，不要简化成 `bytes`。
2. `$out.list()` 的字节数同样标注为捕获时值。
3. **在文档和实现注释里明确：bytes / nodes 预算是准入近似，不是 heap 保证；唯一的 heap 硬边界是 `maxOldGenerationSizeMb`。** 计划 §5.2 已有这句话，实测把它从设计断言升级为已验证事实（最坏 11.8× 向上漂移）。

### 4.3 按槽计费：需要改

**定案：改为按对象身份复用槽位（`identity-reuse`），而不是首版的按槽独立计费。**

§3.6 显示 per-slot 计费在三种回流 trace 中的两种里刷穿历史，而且失效形态最坏：**对象还在 store 里，只是换了 id，模型手上的句柄却 expired**。计划 §5.2 写的"Phase 0 基准必须验证该语义在典型回流形态下不会过早刷穿 history；若刷穿，则改为按对象身份去重计费"——已验证会刷穿，触发了改动条件。

但要注意：计划设想的替代方案是"按对象身份**去重计费**"，实测显示**那不够**。`identity-dedup`（新开槽但不重复计费）在 `explore-then-recirculate` + entries=16 下仍然失败，因为 entries 预算被回流吃掉了。必须是 `identity-reuse`：

- 新 completion 入槽前先按对象身份查 store；
- 命中则**不开新槽、不分配新 id、不重复计费**，直接返回已有 id，并**保持它原有的 FIFO 位置**（符合计划 §5.2"访问旧结果不应无限延长其生命周期"）；
- 未命中才走正常的三重预算准入 + FIFO 淘汰。

好处不止于内存：模型对同一个值反复看到同一个 `$out(N)`，句柄语义更稳，也天然满足验收 #11 的"id 全局单调不复用"（复用的是已有 id，不是回收后重发的 id）。

`filter-chain` trace 证明这不影响正常派生用法：每次产生新对象时三种策略完全一致。

实现代价：身份查找。store 只有 16 个槽，线性扫描即可；不要为此引入 `WeakMap` 反查（会给 store 增加第二条持有路径，与"`drop` 只释放 history 的引用"的语义纠缠）。

### 4.4 64 MiB 场景是否满足进入 Phase 1 的门槛

先给建议的门槛数值（计划 §13 #14 要求 Phase 0 制定，此前未定义）：

| # | 门槛 | 建议阈值 | 实测 | 判定 |
| --- | --- | --- | --- | --- |
| G1 | 单次 64 MiB 合法 completion 的边界 CPU（最坏形状） | ≤ 1000 ms | **4705.7 ms**（wide-object）/ 2142.2 ms（flat-array） | **不达标** |
| G2 | 单次 64 MiB 捕获在 512 MiB 老生代下不 OOM | 必须不 OOM | 五种形状全部通过，峰值 RSS 611.8–823.1 MiB | 达标 |
| G3 | history 装满 + 再来一个 64 MiB completion，在 512 MiB 老生代下不 OOM | 必须不 OOM | 预算 ≤64 MiB 通过；≥128 MiB **OOM** | **在建议默认值（32 MiB）下达标** |
| G4 | history 驻留 heap 占 `maxOldGenerationSizeMb` 比例 | ≤ 15% | 32 MiB 预算 → 47.9 MiB → **9.4%** | 达标 |
| G5 | node 计数的增量 CPU | ≤ 5% | 噪声以内（多个测点为负） | 达标 |
| G6 | 有界投影的 CPU 与值大小无关 | ≤ 1 ms @ 64 MiB | 四种形状 0.001–0.003 ms；**wide-object 787.5 ms** | **有条件达标** |

**判定：G2 / G3 / G4 / G5 达标，G1 不达标，G6 有条件达标。建议放行 Phase 1，但必须附带三条硬性设计约束，且不得在 Phase 2 之前放宽。**

放行的理由是 G1 的失败**不是本计划造成的**：`prepareCompletion` 今天就对每个 64 MiB completion 做全量深拷贝 + stringify（§3.1），这 2.1–4.7 s 是存量成本。Phase 1 只是在同一次遍历里加一个 node 计数器（G5 证明其成本在噪声内），**CPU 上零回归**。用一个存量缺陷去阻塞一个不加重它的阶段，没有意义。

但 G1 必须在 Phase 2 关闭，因此附带条件：

1. **Phase 2 的大 completion 路径不得构造完整 snapshot。** 这是 G1 唯一的关闭路径：超过投影阈值的 completion 走一次**带早退的有界遍历**，在 bytes 或 nodes 预算耗尽的那一刻停止，成本变成 O(预算) 而非 O(值)。§3.7 已经证明这条路可行（64 MiB 上 0.001–0.003 ms）。
2. **准入预算必须在遍历过程中判定，不能遍历完再算。** §3.8 的共享引用放大给出了硬理由：几 KiB 的 live 图可以展开成 274 MB JSON / 2750 万节点 / 1.93 s。遍历后判定意味着放大已经全部发生。这条对 Phase 1 也适用——Phase 1 就要按早退语义写准入，否则 Phase 2 要推倒重来。
3. **key 枚举只做一次。** §3.7 的 wide-object 787 ms 和 §3.7 的 key-iteration 表证明：字典模式大对象上不存在廉价的"取前 16 个 key"。key 计数与前 N 个 key 必须在捕获遍历里一次取到，projector 不得重新枚举。做不到这一点，G6 就永远关不掉。

若团队认为 G1 必须先关再进 Phase 1，那等价于把 Phase 2 的有界遍历提前到 Phase 1 一起做。这也是一个自洽的选择，但会让 Phase 1 从"只加 store 和 `$out`"变成"同时重写 boundary 遍历"，风险更集中。**我的建议是按上面三条约束放行 Phase 1，并把 G1 写成 Phase 2 的出口门槛。**

## 5. 给实施阶段的其他实测结论

- **`long-string` 是免费的。** `snapshotValue` 对字符串返回原引用，64 MiB 字符串的深拷贝耗时 0.002 ms、驻留 heap 增量 0。字符串完成值不需要任何特殊照顾，projector 的 `maxStringChars` 截断要注意不劈开代理对（`bench/projection-bench.mjs` 的 `safeSlice` 是一个可直接搬的实现）。
- **递归深度上限约 7,800**（默认栈，运行间波动）。超出抛 `RangeError`，被现有 `catch` 转成 `invalid-output`。这条边界值得进契约测试，但只断言行为、不断言数值。
- **`Reflect.ownKeys` 比 `Object.keys` 慢 2.3×**（64 MiB wide-object：1951.8 ms vs 857.0 ms）。当前 `snapshotValue` 用的是 `capturedReflectOwnKeys`（`realm-worker.ts:664`），这是 wide-object 形状成为最慢形状的一部分原因。改动它会改变安全语义（`ownKeys` 能看到 symbol 键，正是拒绝它们所必需的），所以**不建议为性能改这一处**，但应知道这笔成本的来源。
- **`bench/results/*.json` 是生成物**，当前未加入 `.gitignore`。是否提交由 team-lead 决定：提交能让门槛数字可追溯，不提交则需要在 CI 或本地重跑。
