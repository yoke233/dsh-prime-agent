# Phase 2 G1 出口门槛复测结果

> 对应计划：`docs/plan/completion-history-output-projection.zh.md` §4.4（G1 判据定案）、§9 Phase 2 出口门槛
> 前序数据：`docs/plan/phase0-bench-results.zh.md`
> 被测对象：真实 `PersistentRealm` 路径（不是 Phase 0 的 bench 复刻）
> 新增脚本：`bench/g1-exit-gate.mjs`、`bench/lib/realm-programs.mjs`（未修改任何 `src/`、`lib/`、`tests/` 文件）

## 0. 判定摘要

**G1 按判据原文通过。**

| 判据成分 | 结论 | 证据 |
| --- | --- | --- |
| 「根对象 own keys 恰好枚举一次、绝不二次枚举」 | **成立** | 代码上每对象只调一次 `capturedReflectOwnKeys` 且样本取自同一份结果；实测 wide-object 整体捕获耗时**低于**同 worker 内单次 `Reflect.ownKeys` 控制组（64 MiB：1713 vs 1991 ms，即 0.86×）。128 MiB 档 worker 在对照 cell 之前即退出，无有效地板读数，故只以 64 MiB 档判定 |
| 其余成本 O(准入天花板) | **成立** | 256 MiB 单数组捕获 **0.68 ms / 0 MiB**；`chunked-array`、`wrapped-array`、`wrapped-string`、`deep-nested` 在 8→256 MiB 全程持平 |

模型可见输出的收缩彻底：全部大 completion 返回 `projected`，wire 字节 **141–1491 B**，8→256 MiB 之间基本不变。

**但有两项残留缺陷**，它们不违反 G1 的字面判据，却违反 Phase 2 出口门槛的另一句「64 MiB 级投影 CPU 与值大小无关（常数量级）」，并且在出厂 512 MiB 老生代下**会打死 worker**：

| # | 残留 | 性质 | 实测 |
| --- | --- | --- | --- |
| R1 | wide-object 的根枚举虽被 G1 豁免 CPU，但其**内存无界** | 豁免项自身的副作用 | 64 MiB：1713 ms；128 MiB：**worker-exit**；256 MiB：**OOM** |
| R2 | 字符串完成值经 Inspector `RemoteObject` **按值内联**跨界，成本在捕获遍历之前 | 边界传值机制，非投影器 | 64 MiB：390 ms / 422 MiB；128 MiB：793 ms / 844 MiB；256 MiB：**worker-exit** |

两者都是**既有机制**、都在投影器职责之外，建议单独立项，不阻塞 Phase 2 收尾。

## 1. 重要过程说明：测量期间实现发生了变更

任务要求「工作树冻结在实现完成态」。实际上 `src/realm/realm-worker.ts` 在 **21:51:36** 被修改（`lib/` 于 21:51:44 重建），而我的首轮权威测量在 **21:44** 完成。因此本文包含两组数据：

- **修复前**（§3）：21:20–21:44 之间三轮独立测量，数值互相吻合；
- **修复后**（§4）：由我在 22:00 后重新完整测量，并与 22:54 出现在 `bench/results/` 中的第三方运行结果交叉验证，两者吻合。

变更内容正是修复前测量所指向的问题，且实现方式与本文 §3.5 将要提出的建议一致（见 §4.1）。**结论以修复后数据为准**；修复前数据保留，因为它是该缺陷曾经存在及其量级的证据。

## 2. 环境与方法

### 2.1 环境

与 Phase 0 同机同环境。

| 项 | 值 |
| --- | --- |
| Node | v24.18.0 |
| OS | Windows 11 Home China 10.0.26200 (win32 x64) |
| CPU | Intel(R) Core(TM) Ultra 9 285K，24 逻辑核 |
| 物理内存 | 63.4 GiB |
| 测量日期 | 2026-08-24 |

Realm 预算除 heap 外取出厂默认：`maxOutputBytes` = 67,108,864（`src/runtime.ts:43`）、`maxOldGenerationSizeMb` = 512（出厂默认，另有 2048 对照）、`computeMs`/`maxWallMs` 放宽至 600 s/900 s 以免超时掩盖耗时数据。

completion 限制全取实现默认：`maxCompletionHistoryEntryBytes` = 8 MiB、`maxCompletionFullBytes` = 64 KiB、`maxCompletionHistoryNodes` = 1,000,000、`maxCompletionProjectionBytes` = 4096。故早退线 = `max(8 MiB, 64 KiB)` = **8 MiB** 与 **1,000,000 node**。

### 2.2 真实路径，构造成本排除在测量窗口外

全部经由真实 `PersistentRealm`（`lib/realm/realm.js`），耗时包含 Inspector `Runtime.evaluate`、边界调用、捕获遍历、投影、`postMessage`、host `OutputLedger` 结算的全链路。

每个用例分两个 cell：**setup cell** 构造形状挂到 `globalThis.__v`、自身完成值是 `'built'`；**measured cell** 程序体只有 `globalThis.__v`。measured cell 之前另跑一次 `undefined` 空 cell 预热。因此 measured cell 的墙钟时间里没有任何构造成本。

### 2.3 对照组

| 对照 | 程序 | 用途 |
| --- | --- | --- |
| `ownKeysFloor` | `Reflect.ownKeys(__v).length` | G1 豁免的单次根枚举地板，同 worker 内实测。实现走 `capturedReflectOwnKeys`（`realm-worker.ts:933`），Phase 0 测得其比 `Object.keys` 慢 2.3×，故判定必须用 ownKeys 作地板 |
| `objKeys` | `Object.keys(__v).length` | 与 Phase 0 §3.7 保持连续性 |
| `touch` | `__v.charCodeAt(__v.length - 1)` | 先行触碰字符串字符，把 rope 展平成本挤出测量窗口 |

两个枚举对照对非对象值短路返回 `-1`——`Object.keys` 作用在 64 MiB 字符串上会物化 6700 万个下标 key 并打爆 worker，那测的是夹具不是实现（首轮 long-string 的「OOM」正是栽在这里，已修正）。

**`--skip-controls`**：对照组自身在超长根数组上也是昂贵的（枚举 1340 万元素数组耗时数秒、占用 1 GiB+），会在 measured cell 已经成功之后把 worker 打死。定位残留问题时必须用它把仪器与被测对象分开——§4.2 的关键结论正来自于此。

### 2.4 形状

除 Phase 0 的五个形状外，新增四个**定位用**形状，把「根枚举」「单个超长数组」「值总量」「Inspector 传值」四个变量拆开：

| shape | 构造 | 拆开的变量 |
| --- | --- | --- |
| `wrapped-array` | `{ data: [...N] }` | 大数组下移一层，根枚举只剩 1 个 key。若成本不变，则该成本不是「根对象 own keys」 |
| `chunked-array` | `[[1000], [1000], …]` | 元素总数与 `flat-array` 相同，但无任何单数组超过 node 天花板 |
| `wrapped-string` | `{ s: "…" }` | 大字符串包进对象，CDP 只回 objectId 而非内联值 |
| `long-string-rope` | 倍增拼接后 slice | 与 `long-string` 同尺寸同内容但表示为 rope，排除展平成本 |

### 2.5 复现命令

```powershell
# 修复后主表（出厂 512 MiB 老生代）
node bench/g1-exit-gate.mjs --sweep --sizes 8,16,64,128 `
  --shapes flat-array,record-array,wide-object,deep-nested,long-string,wrapped-array,chunked-array,wrapped-string,long-string-rope `
  --heap 512 --out g1-verify-postfix-heap512.json

# 隔离对照组，定位残留（关键）
node bench/g1-exit-gate.mjs --sweep --sizes 128,256 `
  --shapes flat-array,wide-object,record-array,long-string `
  --heap 512 --skip-controls --out g1-postfix-nocontrol-heap512.json
```

原始数据：`bench/results/g1-verify-postfix-heap512.json`（修复后主表）、`bench/results/g1-postfix-nocontrol-heap512.json`（隔离对照）、`bench/results/g1-exit-gate-heap512.json` 与 `g1-exit-gate-heap2048.json`（修复前）。

## 3. 修复前：曾经存在的缺陷及其量级

保留此节，因为它是缺陷曾存在及其代价的证据，也是修复方案的推导依据。

### 3.1 现象

出厂 512 MiB 老生代，修复前（`g1-exit-gate-heap512.json`）：

| shape | 8 MiB | 16 MiB | 64 MiB | 128 MiB |
| --- | --- | --- | --- | --- |
| flat-array | 170.1 ms / 115 MiB | 302.9 ms / 163 MiB | **1840.3 ms / 630 MiB** | **OOM** |
| wrapped-array | 171.9 ms / 111 MiB | 311.2 ms / 172 MiB | **1938.1 ms / 632 MiB** | **OOM** |
| chunked-array | 86.4 ms / 44 MiB | 74.1 ms / 27 MiB | 79.5 ms / 59 MiB | 87.1 ms / 121 MiB |

### 3.2 定位

`wrapped-array` 是决定性证据：其根是 `{ data: [...] }`，根枚举实测仅 **0.5 ms**（G1 豁免的那部分在此几乎为零），但捕获成本与根就是数组的 `flat-array` **逐点几乎相同**。即这笔 O(n) 成本与「根不根」无关，**不在 G1 豁免范围内**。

`chunked-array` 从反面确认：元素总数与 `flat-array` 完全相同（838,860 / 1,677,721 / 6,710,886 / 13,421,772 个数字），仅因无单数组超过 node 天花板，就全程持平且无 OOM。同样的数据量差 22 倍耗时、10 倍峰值。

根因是当时 `realm-worker.ts:895` 的数组稀疏性检查：

```ts
if (capturedReflectOwnKeys(items).length !== items.length + 1) throw new CapturedError('value is not lossless JSON')
```

它把数组全部下标 key 物化成字符串数组，成本 O(数组长度)，且发生在下一行 `chargeCapture` **之前**——计费与早退根本没有机会介入。成本的准确刻画是 **O(遇到的最长单个数组)**：走查按 8 MiB 字节天花板累计，能进入的数组总长有界，但最后进入的那一个数组的枚举在计费前已全额付掉，长度不受任何约束。

耗时相对元素数还超线性：**元素总数相同**时，一个 670 万长的数组比 6711 个 1000 长的数组贵 23 倍（1840 vs 79.5 ms）；**同一形状内**，元素数 4 倍（1.68M → 6.71M）耗时 6.1 倍（303 → 1840 ms）。原因是一次性物化 670 万个 key 落进大对象空间并触发 mark-compact，而 1000 长的小数组枚举结果朝生夕死、由 scavenger 廉价回收。

## 4. 修复后：当前状态

### 4.1 已落地的修复

当前 `realm-worker.ts:920-927` 把该检查**推迟到走查结束、并以 `!stats.aborted` 为前提**：

```ts
if (!stats.aborted && capturedReflectOwnKeys(items).length !== items.length + 1) {
  throw new CapturedError('value is not lossless JSON')
}
```

这正是修复前数据所指向的方案，且语义上是安全的：

- **天花板内走完的值行为完全不变**——仍做完整检查，`retained` 与全量返回路径的 lossless 语义一字未改；
- **撞天花板早退的值跳过检查**——与走查对其他所有校验早已采取的做法一致。`snapshotValue` 开头 `if (stats.aborted) return undefined` 意味着天花板外的内容根本不被读取，实现注释亦已明确承认（`realm-worker.ts:1449-1455`：「validity is now judged over the part that was WALKED…a bigint hiding there is never found and the run succeeds with a projection rather than failing」）。既然越界的 bigint 已不触发 `invalid-output`，越界数组的额外属性同样不必触发。
- 空洞检测未受影响：循环内 `capturedObjectHasOwn(items, index)`（`realm-worker.ts:909`）仍逐元素进行，并随早退一起停止。

代价是一个**超出天花板且带额外属性的稀疏数组**会从 `invalid-output` 变成 `retained: false` 的投影。这与既有 bigint 行为一致，但应在契约测试中显式钉住（建议转 phase0-contracts）。

### 4.2 修复后主表（出厂 512 MiB 老生代）

| shape | MiB | 元素数 | capture ms | ownKeys 地板 ms | peakΔ MiB | 结果 | retained | wire B |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| flat-array | 8 | 838,860 | 152.1 | 87.9 | 76.1 | projected | true | 245 |
| **flat-array** | 16 | 1,677,721 | **50.1** | 199.5 | **40.0** | projected | false | 219 |
| **flat-array** | 64 | 6,710,886 | **49.8** | 1586.0 | **29.2** | projected | false | 219 |
| record-array | 8 | 127,100 | 147.7 | 7.8 | 98.1 | projected | true | 1491 |
| record-array | 16 | 254,200 | 138.5 | 18.4 | 119.1 | projected | false | 1464 |
| record-array | 64 | 1,016,800 | **127.5** | 77.0 | 85.2 | projected | false | 1465 |
| record-array | 128 | 2,033,601 | **97.9** | 225.7 | 85.6 | projected | false | 1465 |
| wide-object | 8 | 349,525 | 240.8 | 90.2 | 51.1 | projected | true | 744 |
| wide-object | 16 | 699,050 | 635.8 | 193.3 | 96.3 | projected | false | 752 |
| wide-object | 64 | 2,796,202 | 1713.0 | 1991.1 | 202.5 | projected | false | 718 |
| **wide-object** | **128** | 5,592,405 | 4963.1 | — | 342.6 | **worker-exit** | — | — |
| deep-nested | 8 | — | 83.7 | 0.9 | 46.1 | projected | false | 883 |
| deep-nested | 16 | — | 70.5 | 0.8 | 22.8 | projected | false | 427 |
| deep-nested | 64 | — | 89.9 | 0.7 | 53.9 | projected | false | 427 |
| deep-nested | 128 | — | 97.0 | 3.3 | 139.4 | projected | false | 427 |
| long-string | 8 | — | 52.8 | n/a | 46.6 | projected | false | 399 |
| long-string | 16 | — | 97.9 | n/a | 76.2 | projected | false | 400 |
| **long-string** | 64 | — | **390.0** | n/a | **421.5** | projected | false | 400 |
| **long-string** | 128 | — | **768.2** | n/a | **844.6** | projected | false | 401 |
| long-string-rope | 8 | — | 54.0 | n/a | 34.8 | projected | false | 399 |
| long-string-rope | 16 | — | 104.4 | n/a | 109.2 | projected | false | 400 |
| long-string-rope | 64 | — | 406.3 | n/a | 395.1 | projected | false | 400 |
| long-string-rope | 128 | — | 778.2 | n/a | 862.0 | projected | false | 401 |
| **wrapped-array** | 8 | 838,860 | 154.6 | 0.6 | 80.4 | projected | false | 316 |
| **wrapped-array** | 16 | 1,677,721 | **51.5** | 0.3 | **29.2** | projected | false | 283 |
| **wrapped-array** | 64 | 6,710,886 | **51.5** | 0.7 | **29.5** | projected | false | 283 |
| **wrapped-array** | 128 | 13,421,772 | **0.65** | 0.4 | **0** | projected | false | 205 |
| chunked-array | 8 | 838,860 | 92.3 | 1.1 | 43.6 | projected | false | 1137 |
| chunked-array | 16 | 1,677,721 | 78.0 | 0.4 | 33.5 | projected | false | 1104 |
| chunked-array | 64 | 6,710,886 | 79.5 | 0.7 | 62.7 | projected | false | 1104 |
| chunked-array | 128 | 13,421,772 | 81.7 | 1.1 | 120.8 | projected | false | 1105 |
| wrapped-string | 8 | — | 0.65 | 0.7 | 0 | projected | false | 459 |
| wrapped-string | 16 | — | 0.58 | 0.3 | 0 | projected | false | 460 |
| wrapped-string | 64 | — | 0.64 | 0.4 | 0 | projected | false | 460 |
| wrapped-string | 128 | — | 0.60 | 0.3 | 0 | projected | false | 461 |

主表中 `flat-array@128 MiB` 显示为 OOM，但**那是对照组造成的，不是实现**——见下节。

### 4.3 隔离对照组后的真实上限（`--skip-controls`，512 MiB 老生代）

| shape | MiB | capture ms | peakΔ MiB | 结果 |
| --- | --- | --- | --- | --- |
| **flat-array** | **128** | **0.62** | **0** | projected |
| **flat-array** | **256** | **0.68** | **0** | projected |
| record-array | 128 | 96.1 | 83.8 | projected |
| record-array | 256 | 494.9 | 38.8 | projected |
| **wide-object** | **128** | 5351.6 | 338.9 | **worker-exit** |
| **wide-object** | **256** | — | — | **OOM** |
| **long-string** | **128** | 792.9 | 844.4 | projected |
| **long-string** | **256** | 1605.9 | 1773.5 | **worker-exit** |

**`flat-array` 在 128 / 256 MiB 下捕获耗时 0.62 / 0.68 ms、峰值 0 MiB。** 主表里的 OOM 完全来自我的 `ownKeysFloor` 对照 cell（枚举 1340 万元素数组本身就要数秒和 1 GiB+），在 measured cell 早已成功之后才把 worker 打死。

为何 256 MiB 数组比 64 MiB 数组还快？因为根数组的长度计费 `chargeCapture(stats, items.length + 1)` 一次就把 8 MiB 字节天花板顶穿，走查在读取**任何一个元素之前**即早退。64 MiB 数组（671 万元素）的长度计费尚在天花板内，于是继续逐元素走到 node 天花板才停，故 50 ms。这个非单调性是早退正确工作的表现，不是异常。

### 4.4 逐项判定

**需求 1：64 MiB 端到端耗时对照 Phase 0 存量基线（2.1–4.7 s）**

Phase 0 是进程内复刻的深拷贝 + stringify，不含 Inspector 与 wire；本次是全链路，口径不完全一致，方向性对比：

| shape @64 MiB | Phase 0 复刻 | Phase 2 修复后 | 变化 |
| --- | --- | --- | --- |
| flat-array | 2166 ms | **49.8 ms** | **−97.7%** |
| record-array | 769 ms | **127.5 ms** | **−83.4%** |
| wide-object | 4572 ms | 1713.0 ms | **−62.5%** |
| deep-nested | 498 ms | **89.9 ms** | **−81.9%** |
| long-string | 68 ms | 390.0 ms | +474%（见 R2；Phase 0 复刻从不跨 Inspector，该成本在其表中不可见） |

峰值内存同步改善：`flat-array` 从 552 MiB（Phase 0）降到 29 MiB，`record-array` 从 395 MiB 降到 85 MiB。

**需求 2：G1 判据** —— 通过。豁免项成立（代码每对象一次枚举 + wide-object 捕获低于单次 ownKeys 地板）；其余部分 O(准入天花板)（256 MiB 数组 0.68 ms）。

**需求 3：耗时是否随值大小趋平**

| shape | 8 → 16 → 64 → 128 MiB | 判定 |
| --- | --- | --- |
| `wrapped-string` | 0.65 → 0.58 → 0.64 → 0.60 ms | 持平 ✅ |
| `wrapped-array` | 155 → 52 → 52 → 0.65 ms | 持平（且单调下降）✅ |
| `flat-array` | 152 → 50 → 50 → 0.62（隔离对照）ms | 持平 ✅ |
| `chunked-array` | 92 → 78 → 80 → 82 ms | 持平 ✅ |
| `deep-nested` | 84 → 70 → 90 → 97 ms | 持平 ✅ |
| `record-array` | 148 → 139 → 128 → 98 ms | 持平 ✅ |
| `wide-object` | 241 → 636 → 1713 → 4963 ms | 线性，**属豁免项** ⚠️ |
| `long-string` | 53 → 98 → 390 → 768 ms | **线性** ❌（R2） |

除豁免项与 R2 外全部趋平。

**需求 4：早退后峰值内存是否有界**

| shape | peakΔ 8 → 16 → 64 → 128 MiB | 判定 |
| --- | --- | --- |
| `wrapped-string` | 0 → 0 → 0 → 0 MiB | 有界 ✅ |
| `flat-array` | 76 → 40 → 29 → 0 MiB | 有界 ✅ |
| `wrapped-array` | 80 → 29 → 30 → 0 MiB | 有界 ✅ |
| `chunked-array` | 44 → 34 → 63 → 121 MiB | 有界 ✅ |
| `record-array` | 98 → 119 → 85 → 86 MiB | 有界 ✅ |
| `deep-nested` | 46 → 23 → 54 → 139 MiB | 有界 ✅ |
| `wide-object` | 51 → 96 → 203 → 343 MiB | **无界**（R1）❌ |
| `long-string` | 47 → 76 → 422 → 845 MiB | **无界**（R2）❌ |

**关于交接信息 (b) 的验证**：phase1-impl 提示「走查字节估算对数字只 charge 1 字节（最坏低估约 20 倍），大数字数组形状的实测峰值会比 8 MiB 高一个常数倍，那是记账松弛不是早退失效」。

修复后该说法**完全成立并已验证**：纯数字数组形状（`flat-array` / `wrapped-array` / `chunked-array`）峰值分别为 0–80 / 0–80 / 34–121 MiB，相对 8 MiB 早退线约 5–15 倍，与「低估约 20 倍」量级一致，且在 8→256 MiB 全程**保持常数上界**，node 天花板兜底有效。

需要补充的是：修复前那 630 MiB 峰值**不是记账松弛造成的**，而是 §3.2 的枚举物化——两者需分开归因，修复后才只剩记账松弛这一项。

## 5. 残留缺陷与建议

### 5.1 R1：被豁免的根枚举其内存同样无界

G1 豁免的是这笔枚举的 **CPU**，Phase 0 也证明字典模式大对象上不存在廉价的「取前 N 个 key」。但实测表明它的**内存**也随 key 数增长，并在出厂配置下打死 worker：

- 64 MiB / 280 万 key：1713 ms、203 MiB，通过；
- 128 MiB / 559 万 key：**worker-exit**；
- 256 MiB：**OOM**。

即：一个模型完全可能自然产生的大字典对象（例如按 id 聚合的映射），会让 Prime Realm 的 worker 直接死掉并丢失整个 namespace，而不是得到一个 `retained: false` 的投影。这在模型可见行为上比慢更严重。

建议：在进入根对象枚举**之前**先用一个不需要枚举的信号做预检（如对象是否处于字典模式、或先前 cell 已知的规模），或在 host 侧对 worker-exit 场景补一条明确的「completion 过大导致 namespace 重启」诊断，而不是让它表现为通用 hard-kill。这属于 §8 失败语义的补充，建议单独立项。

### 5.2 R2：大字符串完成值不应内联穿过 Inspector

`long-string` 与 `long-string-rope` 逐点一致（54/104/406/778 vs 53/98/390/768 ms），且 `touch` 对照仅 0.4–1.6 ms——**排除 rope 展平**。

`wrapped-string` 给出定位：同样大小的字符串包进对象后，捕获 **0.60–0.65 ms、峰值 0 MiB、8→128 MiB 全程持平**。差别只有一个：CDP `RemoteObject` 对**原始值**内联携带 `value`，对对象只回 `objectId`。字符串完成值因此在捕获遍历开始之前就被完整编码进 Inspector 响应再解码回来，产生 O(长度) 耗时与约 6.6× 的瞬时内存（128 MiB 字符串 → 845 MiB），256 MiB 时 worker-exit。

捕获遍历对字符串本身是 O(1) 的（`chargeCapture(stats, 2 + length)` 后立即 abort，`projectString` 只切 256 字符）——`wrapped-string` 的 0.6 ms 就是它的真实成本。

可选方向（按侵入性排序）：

1. 在边界求值时把完成值包一层，拿到 `objectId` 后在 main world 内解包——有实测支撑（`wrapped-string` 全程 0.6 ms / 0 MiB），但改动落在边界传值机制上；
2. 取回前先看 `RemoteObject` 元信息，对超长字符串只取前缀（需确认 CDP 是否有不拉全量的取法）；
3. 兜底：host 侧对字符串完成值做长度预检并直接走最小引用 envelope。

同样属于既有机制，建议单独立项，不阻塞 Phase 2 收尾。

### 5.3 防回归门槛

建议把以下项固化为 Phase 2 之后的回归门槛：

| 判据 | 阈值 | 当前 |
| --- | --- | --- |
| `wrapped-array` 8→256 MiB 耗时持平 | 最大/最小 ≤ 3× | ✅（155 → 0.65 ms，单调下降） |
| `flat-array` 256 MiB 捕获 | ≤ 10 ms、峰值 ≤ 8 MiB | ✅（0.68 ms / 0 MiB） |
| `chunked-array` / `wrapped-string` / `deep-nested` / `record-array` 持平 | 最大/最小 ≤ 3× | ✅ |
| wide-object 捕获 ≤ 单次 ownKeys 地板 × 1.2 | 防二次枚举回归 | ✅（0.86×） |
| wide-object 128 MiB 不 worker-exit | R1 修复后 | ❌ 待修 |
| `long-string` 128 MiB 峰值 ≤ 2× 字符串大小 | R2 修复后 | ❌ 待修（6.6×） |

## 6. 附带观察

- **identity-reuse 不省捕获 CPU**。同一值第二次作为完成值返回时，`repeat` 耗时与首次基本相同（修复前 record-array 64 MiB：248 → 203 ms；flat-array 64 MiB：1840 → 1922 ms）。身份命中发生在走查**之后**（走查要先算出 bytes/nodes），故回流形态省的是槽位与内存，不省 CPU。这与 §5.2 定案不冲突（identity-reuse 的目标本就是句柄稳定与内存），但若将来想让回流变便宜，需要在走查前先做身份查找。
- **`retained` 与 `reason` 的分界符合 §4.4 要求**：8 MiB 档的 `flat-array` / `record-array` / `wide-object` 得到 `retained: true`（capture bytes 8,388,601 / 8,072,644 / 6,990,501，均在 8 MiB 单槽上限内）；装得下但太大不留时 `reason` 为 `too large to retain` 并带精确 `serializedBytesAtCapture`；撞天花板早退时为 `too large to capture` 且 `serializedBytesAtCapture` 为 `null`。「精确记账只对会被保留的值保留」得到实证。
- **wire 字节远低于预算**：实测 141–1491 B，`maxCompletionProjectionBytes` = 4096 仍有 2.7× 以上余量，Phase 0 定值无需调整。
