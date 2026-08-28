# 最小持久 `$state`：可复用项目调研

> 对应议题：[yoke233/dsh-prime-agent#17](https://github.com/yoke233/dsh-prime-agent/issues/17)  
> 核对日期：2026-08-29  
> 范围：Node.js / TypeScript、per-session、显式、lossless-JSON、有界、原子 checkpoint；不恢复任意 JavaScript binding，不引入替代 JavaScript 引擎。

## 结论：build，但复用已有 primitive

**没有发现一个新依赖，能明确优于“复用已有原子写 primitive + 一层很小的受控 JSON checkpoint”。** 推荐：

1. 直接复用项目已经声明的 [`@deepseek-ai/dsh-atomic-write`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/util/atomic-write)。它提供同目录随机临时文件、`wx`、rename replace、显式 mode 和跨进程 writer lock；官方也明确说明它 **atomic, not durable**，不做 file/directory `fsync`。[README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/atomic-write/README.md) [源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/atomic-write/src/index.ts)
2. 直接复用现有 [`@deepseek-ai/dsh-session` 的 `snapshotJsonValue`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/json.ts)：一次遍历完成隔离快照和 lossless-JSON 验证，接受有限数值（拒绝 `-0`）、稠密普通数组、普通/null-prototype 对象，拒绝 cycle、unsupported scalar 与 exotic prototype。[说明](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/session#lossless-json-utilities)
3. 只在 Host 侧补 `load / checkpoint / delete` 小模块：每 realm/session 一个 versioned JSON 文件，写前按 UTF-8 byte length 做硬上限；Worker 只收发 JSON value，不获得 `DSH_HOME` 路径或文件系统权限。

所有候选都仍要求本项目自行定义文件布局、版本 envelope、字节上限、session identity、错误语义和 Worker/Host protocol。引入通用 KV、配置库或 graph checkpoint 只会增加无关能力。

### Shortlist（不超过三项）

| 排名 | 项目 | 采用级别 | 结论 |
|---|---|---|---|
| 1 | [`@deepseek-ai/dsh-atomic-write`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/util/atomic-write) | **直接复用已有依赖** | **采用为底层 primitive**；上层自己做 lossless JSON、版本、session 路径和大小限制。不要宣称掉电 durability。 |
| 2 | [Node-RED `localfilesystem`](https://nodered.org/docs/api/context/store/localfilesystem) | **只借鉴设计** | 借鉴“一个 scope 一个 JSON 文档”和 lifecycle；不采用其默认 30 秒延迟 flush。 |
| 3 | [unstorage `fs` driver](https://github.com/unjs/unstorage/blob/main/src/drivers/fs-lite.ts) | **观察/设计借鉴** | v2 `atomic:true` 最接近零依赖通用 KV，但稳定 v1 尚无该能力，v2 仍为 alpha；不直接依赖。 |

## 判定口径与发现方法

本文区分三层保证：**原子可见性**（reader 只见完整旧/新文件）、**进程崩溃一致性**（rename 前后和遗留 temp/lock 的恢复）、**掉电 durability**（内容和目录项均真正落盘）。temp→rename 通常只证明第一层；严格 durability 一般还需 flush/fsync temp file，并在 rename 后 fsync parent directory。

“lossless-JSON”也不等于“`JSON.stringify` 不抛”：必须拒绝会被静默删除或改写的 `undefined`、函数、symbol、bigint、cycle、稀疏数组、非有限数值和 `-0` 等。项目已有 `snapshotJsonValue`，不应另造第二种边界。[源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/json.ts)

发现步骤：

1. 核对要求点名的 Node-RED context、Keyv/unstorage、LangGraph JS checkpoint。
2. 在 GitHub 用 `atomic JSON TypeScript`、`filesystem key value TypeScript`、`checkpoint thread_id TypeScript`、`session persistence Node.js` 补充检索；只以项目自己的 README、源码、package manifest、release 和 LICENSE 作为事实证据。
3. 与本项目基线比较：当前 [`continual/store.ts`](https://github.com/yoke233/dsh-prime-agent/blob/main/src/continual/store.ts) 已组合 stringify、UTF-8 byte gate、读前 `stat`、opaque session digest、`0o600/0o700`、writer lock 与 atomic replace；[`identity.ts`](https://github.com/yoke233/dsh-prime-agent/blob/main/src/realm/identity.ts) 已把 session identity 映射成路径安全 opaque realm id。

## 候选矩阵

| 候选 | API / 隔离与格式 | atomic / crash / size | 重量、安全、许可证与维护 | 结论 |
|---|---|---|---|---|
| **现有 DSH primitive + 小 JSON wrapper** | `writeFileAtomic(path,string,{mode})`、`withFileLock`；caller 用 opaque per-session filename；上层单一 versioned JSON。[README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/atomic-write/README.md) | 随机 sibling temp、`wx`、rename，reader 看旧或新完整内容；lock 跨进程串行 RMW。**无 fsync**；hard byte bound 由上层做，现有 store 已有范式。[store](https://github.com/yoke233/dsh-prime-agent/blob/main/src/continual/store.ts) | 已有 peer dependency；Node built-ins；显式 mode、随机 temp 和不跟随可猜 temp symlink 的 `wx`。MIT、活跃 monorepo。[package](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/atomic-write/package.json) [LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE) | **采用**。 |
| **Node-RED `localfilesystem`** | 内部 `open/close/get/set/keys/delete/clean`；global/flow/node 各一 pretty JSON 文件。[源码](https://github.com/node-red/node-red/blob/main/packages/node_modules/%40node-red/runtime/lib/nodes/context/localfilesystem.js) | 默认 cache=true，每 30 秒 flush，异常退出可丢最近窗口；close 最终 flush。timestamp temp→rename，但无 file/dir fsync、跨进程 lock/CAS，也无硬上限。[文档](https://nodered.org/docs/api/context/store/localfilesystem) | 属于整个 `@node-red/runtime`，依赖 `fs-extra`、Node-RED util/memory store；Apache-2.0，5.0.4 活跃。[package](https://github.com/node-red/node-red/blob/main/packages/node_modules/%40node-red/runtime/package.json) [release](https://github.com/node-red/node-red/releases/tag/5.0.4) [LICENSE](https://github.com/node-red/node-red/blob/main/LICENSE) | **只借鉴** scope 文件与 lifecycle；显式 checkpoint 必须 await commit。 |
| **unstorage `fs/fs-lite`** | async KV、mount、每 key 文件；普通对象/数组走 JSON，primitive/raw 另路，不是严格单 JSON contract。[README](https://github.com/unjs/unstorage/blob/main/README.md) [driver](https://github.com/unjs/unstorage/blob/main/src/drivers/fs-lite.ts) | v2 `atomic` 默认 false；开启后随机同目录 temp→chmod→rename，无 file/dir fsync、lock/CAS、hard bound。[helper](https://github.com/unjs/unstorage/blob/main/src/drivers/utils/node-fs.ts) 稳定 v1.17.5 直接写，无该 atomic option。[v1](https://github.com/unjs/unstorage/blob/v1.17.5/src/drivers/fs-lite.ts) | v2 核心无 runtime dependency，路径拒绝 `..` segment；仍需 caller 管 base/symlink/mode。MIT；1.17.5 stable、2.0.0-alpha.8 活跃。[package](https://github.com/unjs/unstorage/blob/main/package.json) [releases](https://github.com/unjs/unstorage/releases) [LICENSE](https://github.com/unjs/unstorage/blob/main/LICENSE) | **观察，不依赖**。只有项目已需要统一 storage mount 时才值。 |
| **Keyv + adapter** | `get/set/delete/clear`、namespace、TTL；核心默认 memory，持久性由 adapter 决定。[README](https://github.com/jaredwray/keyv/blob/main/core/keyv/README.md) 默认 serializer 有 bigint/Buffer tag、走 `toJSON`、丢对象 `undefined`，不是严格 lossless JSON。[serializer](https://github.com/jaredwray/keyv/blob/main/core/keyv/src/json-serializer.ts) | 核心无文件 flush/atomic/crash guarantee；无应用 byte bound，TTL 不是容量限制。 | v6 core 有 `hookified`，持久 adapter 再增数据库面。MIT；v6 RC 活跃，v5 只做维护/安全。[package](https://github.com/jaredwray/keyv/blob/main/core/keyv/package.json) [releases](https://github.com/jaredwray/keyv/releases) [LICENSE](https://github.com/jaredwray/keyv/blob/main/LICENSE) | **拒绝**：核心不解决持久原子写，adapter 比单文件重。只借鉴 namespace。 |
| **lowdb + steno** | `JSONFilePreset`、显式 `read/write/update`；caller 每 session 选 filename；whole-file pretty JSON。[README](https://github.com/typicode/lowdb/blob/main/README.md) | steno 固定 `.basename.tmp`、实例内 queue、write→rename；无 fsync、跨进程 lock/CAS、hard bound，同路径多实例共享 temp。[TextFile](https://github.com/typicode/lowdb/blob/main/src/adapters/node/TextFile.ts) [steno](https://github.com/typicode/steno/blob/main/src/index.ts) | 一个 runtime dep `steno`；仍需自己做 strict JSON/path/bound。MIT，v7.0.1（2023-12-26），维护节奏较慢。[package](https://github.com/typicode/lowdb/blob/main/package.json) [release](https://github.com/typicode/lowdb/releases/tag/v7.0.1) [LICENSE](https://github.com/typicode/lowdb/blob/main/LICENSE) | **只借鉴显式 API；拒绝依赖**。不比现有 primitive 更安全。 |
| **LangGraph `MemorySaver`** | `get/getTuple/list/put/putWrites/deleteThread`；`thread_id → checkpoint_ns → checkpoint_id`，再含 task/idx。[base](https://github.com/langchain-ai/langgraphjs/blob/main/libs/checkpoint/src/base.ts) 默认 JsonPlus revive Set/Map/Error/bytes/LangChain 对象，不是纯 JSON。[serde](https://github.com/langchain-ai/langgraphjs/blob/main/libs/checkpoint/src/serde/jsonplus.ts) | 仅内存，无 flush/recovery；无写入上限，`list(limit)` 只限制读取。 | 需 `@langchain/core` peer；MemorySaver 专门防 prototype-pollution key，typed revival 仍扩大安全面。MIT、1.1.5、活跃。[memory](https://github.com/langchain-ai/langgraphjs/blob/main/libs/checkpoint/src/memory.ts) [package](https://github.com/langchain-ai/langgraphjs/blob/main/libs/checkpoint/package.json) [releases](https://github.com/langchain-ai/langgraphjs/releases) | **拒绝**；只借鉴复合 key 与 delete。 |
| **LangGraph SQLite/Postgres savers** | thread/ns/checkpoint 复合键；checkpoint、metadata、parent 与 pending writes 是 graph history。[SQLite](https://github.com/langchain-ai/langgraphjs/blob/main/libs/checkpoint-sqlite/src/index.ts) [PG schema](https://github.com/langchain-ai/langgraphjs/blob/main/libs/checkpoint-postgres/src/migrations.ts) | DB statement/transaction；但 `put()` 与 `putWrites()` 是分开的 atomic boundary。无应用 byte/item/retention 上限。 | SQLite 带原生 `better-sqlite3`；Postgres 带 `pg`、网络、凭据、migration。MIT、活跃；官方定位 SQLite 本地 workflow、PG production。[packages](https://github.com/langchain-ai/langgraphjs/tree/main/libs) [docs](https://github.com/langchain-ai/langgraphjs/blob/main/docs/docs/concepts/persistence.md#checkpointer-libraries) | **拒绝**：DB 与 graph schema 明显过量。 |
| **`write-file-atomic`** | 只做 bytes/string；JSON、namespace、size 全由 caller。[README](https://github.com/npm/write-file-atomic/blob/main/README.md) | temp→默认 fsync temp fd→close→rename；同进程同 absolute filename 排队。无跨进程 lock/CAS，源码无 rename 后 parent-dir fsync。[源码](https://github.com/npm/write-file-atomic/blob/main/lib/index.js) | 一个 `signal-exit` dependency；ISC、v8 活跃。[package](https://github.com/npm/write-file-atomic/blob/main/package.json) [LICENSE](https://github.com/npm/write-file-atomic/blob/main/LICENSE.md) | **拒绝新增**：若无现成 primitive 会是合理 buy；本项目已有 DSH primitive，重复依赖仍不能给完整 durability。 |
| **`@rejetto/kvstorage`** | LevelDB-like `open/get/put/del/flush/sublevel`；append-only JSON-lines，大值进 bucket/files，还支持 Date/Buffer/reviver；同一路径多实例/进程明确不支持。[README](https://github.com/rejetto/kvstorage/blob/main/README.md) | delayed put、显式 flush、rewrite temp cleanup；不是单个旧/新完整 JSON document。threshold 是存放策略，不是拒绝超限的 hard cap。 | 零依赖、MIT、0.17.7、活跃；但 append log/compaction/bucket/offload/codecs 扩大状态与路径面。[package](https://github.com/rejetto/kvstorage/blob/main/package.json) | **拒绝**：协议比目标复杂且语义不匹配。 |

## 三个重点生态的判断

### Node-RED

可借鉴点是“scope 作为持久单元”，避免所有 session 竞争/全量改写一个文件；运行对象与持久快照分离；close 考虑最终 commit。[文档](https://nodered.org/docs/api/context/store/localfilesystem) 但 `$state` checkpoint 不能容忍其默认 30 秒窗口；成功返回前必须 await Host commit。非法/超限状态应保留最后成功 checkpoint 并显式失败，不能用 cycle-safe serializer 修剪后继续。其 store 是 Node-RED runtime 内部模块，也不是可拆下来的轻依赖。[源码](https://github.com/node-red/node-red/blob/main/packages/node_modules/%40node-red/runtime/lib/nodes/context/localfilesystem.js)

### Keyv / unstorage

Keyv 的 namespace 与 adapter seam 值得借鉴，但未选择 adapter 前无法回答 persistence/atomicity，默认 serializer 又比 strict JSON 宽。[Keyv](https://github.com/jaredwray/keyv/tree/main/core/keyv) unstorage v2 更接近需求，却仍缺 lossless snapshot、byte bound、trusted identity mapping、cross-process lock/CAS、fsync 和明确 `0o600/0o700` policy；且 atomic path 尚在 alpha。[unstorage](https://github.com/unjs/unstorage) 因此不为一个窄 checkpoint 引入通用 KV。

### LangGraph JS

LangGraph checkpoint 是图执行的版本/parent/channel/pending-writes 历史，不是一个当前值式 `$state`。[base](https://github.com/langchain-ai/langgraphjs/blob/main/libs/checkpoint/src/base.ts) 可借鉴 `thread_id + namespace + checkpoint_id` 分层和窄 lifecycle API；不可搬入 typed revival、graph schema 与 DB backends。数据库 transaction 还提示一个重要审查原则：必须写清完整 atomic boundary，不能因“用了数据库”就把分开的 `put` / `putWrites` 称为一次原子 checkpoint。[SQLite](https://github.com/langchain-ai/langgraphjs/blob/main/libs/checkpoint-sqlite/src/index.ts) [Postgres](https://github.com/langchain-ai/langgraphjs/blob/main/libs/checkpoint-postgres/src/index.ts)

## GitHub 补充发现

- **OpenAI Agents JS `Session`**：接口很窄；其 transaction-aware contract 要求 `operationId` 与 history mutation 原子持久化，同 ID 重试不重复，不同 payload/suffix mismatch 必须无修改失败。[接口](https://github.com/openai/openai-agents-js/blob/main/packages/agents-core/src/memory/session.ts) 官方 [`MemorySession`](https://github.com/openai/openai-agents-js/blob/main/packages/agents-core/src/memory/memorySession.ts) 仅 demos/tests、不持久。**强借鉴 generation/CAS/idempotency，不依赖。**
- **Anthropic SessionStore examples**：project/session/subpath 隔离键可借鉴；但 README 明言未发布 npm、非 production、CI 不构建测试，Redis list 无 TTL/无界且坏 JSON 可跳过。[README](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/examples/session-stores/README.md) [Redis](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/examples/session-stores/redis/src/RedisSessionStore.ts) 授权为 All rights reserved / Commercial Terms。[LICENSE](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/LICENSE.md) **只借概念，拒绝复制/依赖。**
- **GitHub Copilot SDK persistence**：按 sessionId 落 `checkpoints/*.json`，但恢复 conversation/tool results/plan/artifacts，范围远超 `$state`；文档未声明 fsync/rename/crash-atomic。SDK 还是带 Copilot CLI、`koffi`、JSON-RPC、zod 的控制层。[文档](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/session-persistence) [package](https://github.com/github/copilot-sdk/blob/main/nodejs/package.json) **拒绝。**

## 建议的 Worker / Host / `DSH_HOME` 集成

**持久化由 Host 拥有。** 当前 Host 以 opaque `realmId` 管理长寿命 Worker、`stateDirectory` 和 realm lease；Worker 执行 model code。[runtime](https://github.com/yoke233/dsh-prime-agent/blob/main/src/realm/runtime.ts) [worker](https://github.com/yoke233/dsh-prime-agent/blob/main/src/realm/realm-worker.ts) 不应把 `DSH_HOME` 或 checkpoint 路径交给 Worker。

```text
trusted session identity
  -> Host identity resolver -> opaque realmId
  -> Host bounded load + parse + envelope validation
  -> private HostToRealm message: JsonValue
  -> Worker runtime-owned $state
  -> explicit checkpoint boundary
  -> snapshotJsonValue (single accepted snapshot)
  -> private RealmToHost message: JsonValue
  -> Host stringify + UTF-8 byte gate
  -> writeFileAtomic(mode 0o600, dirMode 0o700)
```

沿用 [`identity.ts`](https://github.com/yoke233/dsh-prime-agent/blob/main/src/realm/identity.ts) 的 opaque realm id，文件可置于 `path.join(stateDirectory, "repl-state", realmId + ".json")`；不要直接拼接不可信 session string。`stateDirectory` 是 Host 已解析的绝对状态根，也是与 `DSH_HOME` 的唯一集成点。

最小格式足够：

```json
{"version":1,"state":{}}
```

- `version` 只用于格式 migration/拒绝未知格式，不引入 checkpoint history。
- `state` 先经 `snapshotJsonValue`；禁用 replacer、`toJSON`、tagged bigint/Buffer 和 constructor revival。
- 最终 rendered UTF-8 bytes 做硬上限；读取先 `stat` 拒绝明显超限，再读、复核 bytes、parse、验证 envelope。顺序可直接沿用 [`continual/store.ts`](https://github.com/yoke233/dsh-prime-agent/blob/main/src/continual/store.ts)。
- 非法、超限、截断或未知版本 fail closed，最后成功 checkpoint 不变。
- 同 realm 的执行已串行，Host 还有 realm lease；若没有外部 writer，第一版不必再加 lock。若允许离线/多 Host writer，则沿用现有 `withFileLock` convention。
- checkpoint 成功以 Host `writeFileAtomic` resolve 为准。Worker hard-kill 后只恢复最后成功 JSON checkpoint；lexical binding、closure、module cache、timer、handle 一律不恢复。

### atomic/crash 承诺

第一版可以准确承诺：reader 只见完整旧/新文件，失败写不替换最后成功文件。当前 DSH primitive官方明确无 fsync，所以不能承诺掉电后一定保留最新 rename。[限制](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/atomic-write/README.md#known-limitations-and-deferred-work)

若 #17 最终要求 power-loss durable-latest，应增强共享 DSH primitive：flush/fsync temp、rename、再 fsync parent directory，并定义 Windows 降级。仅换成 `write-file-atomic` 或 `atomically` 没有 parent-directory fsync 证据，不能完整解决。[write-file-atomic](https://github.com/npm/write-file-atomic/blob/main/lib/index.js) [atomically](https://github.com/fabiospampinato/atomically/blob/master/src/index.ts)

## 集成成本与最终 reject

| 方案 | Worker/Host 成本 | 新依赖/运维 | 判断 |
|---|---|---|---|
| 已有 DSH primitives + 小 wrapper | `$state` + 两条私有消息 + 小 store；复用 realmId/stateDirectory/byte gate | 无 | **最低且同构，选择** |
| Node-RED/lowdb/unstorage | 相同 protocol/envelope/identity/bound 仍都要写 | 新 package；Node-RED 尤重 | 无净收益 |
| Keyv + adapter | 还要 adapter lifecycle/serializer policy | DB adapter | 过重 |
| LangGraph SQLite/Postgres | 还要把 value 映射成 graph checkpoint | native SQLite 或 PG 服务/migration | 模型错误、最高成本 |

明确 reject：Node-RED（内部 runtime、延迟 flush）；unstorage（相关 atomic 能力仍 alpha）；Keyv（核心不持久）；lowdb（不比现有 primitive 更安全）；LangGraph savers（graph/DB 过量）；`write-file-atomic`/`atomically`（重复 primitive 且仍无完整 directory durability）；`conf`（同步配置系统、依赖重且有非原子 fallback，[源码](https://github.com/sindresorhus/conf/blob/main/source/index.ts)）；kvstorage（append/delay/compaction 模型不符）；OpenAI MemorySession（仅内存）；Anthropic examples（非生产且授权不适合）；Copilot SDK（恢复范围过宽、atomicity 未声明）。长期无维护的 [`node-atomic-json-store`](https://github.com/ironSource/node-atomic-json-store) 也没有比当前权限/identity convention 更可信的优势。

## 最终 buy/build 决策

- **Buy/reuse：** 已在依赖图中的 `@deepseek-ai/dsh-atomic-write` 与 `snapshotJsonValue`。
- **Build：** Host 侧很小的 per-realm versioned JSON wrapper，拥有路径、边界、版本与错误语义。
- **Do not buy：** 任何新增 KV、config、graph checkpoint、database 或第二个 atomic-write 包。

因此，对“是否存在可直接依赖、明显优于几十行受控 JSON checkpoint 的项目”的明确回答是：**没有。最优的直接复用对象已经在依赖图里；其上的少量业务约束正是 dsh-prime-agent 必须自己拥有的模块边界。**
