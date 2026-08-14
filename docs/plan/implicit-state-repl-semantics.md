# Realm 隐式 state(REPL 语义)设计方案

## 状态

提案 v1。定义把 Realm 从"显式 `state.x =` 持久化"升级为"顶层声明隐式持久化"的机制、边界与启动条件,不表示实现已开始。

**本方案有明确的启动条件,当前处于待命状态**:policy 已补上"state 跨 run_code 调用持续存在"的显式提示(`995127c` 前一提交,f8a2d62)。若后续真实会话数据表明模型在被告知后仍不使用 state,再启动本方案;若提示词已足够,本方案永久搁置,零成本。

## 背景与证据

对真实会话转录(`--D-yjky-yj-app-backend--`,61 个 `run_code` 程序)的分析:

- `state.` 引用为 **0**,机会窗口完整存在(realm 全程 generation 1 retained)。
- pwsh 结果解包样板在程序间重复 16 次,内联 helper 函数重复定义 8 处——正是隐式持久能免费消除的浪费。
- 根因是语义先验:模型在所有其他 harness 中学到"每次工具调用的程序是隔离的";Prime Agent 的原始设计用 IPython 免费继承了"notebook 变量跨 cell 存活"的先验,我们的自造 TypeScript Realm 享受不到。

## 目标

1. 程序顶层 `const/let/class/function` 声明在同 generation 的后续 run 中隐式可见,允许自由重声明(对齐 IPython rebinding 语义)。
2. `state` 保持唯一治理账本:`maxStateEntries` 计数、`Reflect.ownKeys` 枚举、`delete state.x` 剪枝、超限报错全部不变。
3. 同 realm 执行不变:`realm-worker` 现有的原型捕获、timer 追踪、hidden binding 过滤、strict mode 防护全部保留。
4. 显式 `state.x =` 写法继续有效,新旧程序风格共存。
5. run 内部的 `const` 不可变性与 TDZ 语义不受损。

## 非目标

- 不引入 IPython/Jupyter kernel 或任何第二运行时进程。
- 不切换到 `vm.createContext` 或其他新 realm/隔离方案。
- 不去除 `'use strict'`。
- 不提供父子 Agent 共享命名空间;跨 Agent 上下文传递属于 v0.4 Context Capsule(不可变 share/mount + 显式授权),与本方案正交。
- 不把隐式持久扩展到 `globalThis` 写入或原型污染等旁路;它们仍是不受支持且不受治理的用法。

## 已否决的路线

| 路线 | 否决理由 |
| --- | --- |
| 去掉 `'use strict'` | 只覆盖未声明赋值,模型习惯写 `const`;拼写错误静默变持久全局;对不可写属性赋值(如 `state = {}`)从抛 TypeError 变成静默无效 |
| 裸 `vm.createContext` REPL 语义 | 顶层 `let/const` 落在全局词法环境:跨脚本重声明抛 SyntaxError;绑定不可枚举、不可删除,治理与剪枝不可行;跨 realm 使 host 对象 `instanceof` 破碎,同 realm 原型防护需全部重推 |
| V8 REPL mode(Deno REPL/Jupyter 与 Node 27 主干 [nodejs/node#64034](https://github.com/nodejs/node/pull/64034) 路线) | 引擎级支持重声明,但绑定存于 script context 链而非对象属性:`Reflect.ownKeys` 数不到、无法删除单个绑定,两条治理红线均不可行;仅经 inspector 协议触达,已发布 Node 无此能力(v24 实测重声明抛错) |
| 采用现成库 | 调研结论(见下节):机制正确的实现全部嵌在各自产品里,无独立库形态 |
| 接入 IPython | 每次工具调用跨进程 + 语言边界;Kernel 生命周期、崩溃恢复、配额、Session 绑定需另建;DSH scoped SDK 的类型、权限 lease、输出治理全部退化为裸 RPC |

## 生态调研结论(2026-08,已在源码层面核实)

三个互不相关的生产实现独立收敛到与本方案同构的"声明重写 + 属性寄存"机制:

1. **tslab**([yunabe/tslab](https://github.com/yunabe/tslab),Apache-2.0):cell 视为 module,TS 编译器把顶层声明转译为 `exports.x = x`(= 本方案脱水尾声);引用上个 cell 变量时经 type checker 精确改写为 `exports.x`(= 水合前奏);持久命名空间是普通对象,可枚举可删;重声明 = 新局部绑定 + 尾声覆写。执行核心绑死 TS 编译器,不可独立引入。
2. **JupyterLite javascript-kernel**([jupyterlite/javascript-kernel](https://github.com/jupyterlite/javascript-kernel)):meriyah 解析,保留原声明,尾部追加 `globalThis["k"] = this["k"] = k`,与本方案几乎逐字相同;证明 acorn 级 parser 足够,无需 Babel/TS。
3. **Node 核心 `lib/internal/repl/await.js`**:经典 REPL 处理 top-level await 时用 acorn 重写顶层声明(剥关键字改赋值表达式、头部补 hoisted 声明、async IIFE 包装、末尾表达式捕获),官方背书的同 realm 声明重写参考实现,MIT 兼容可借鉴代码结构。

反面教材:ijavascript 裸 `vm.runInThisContext`,重声明抛错,官方解法是重启 kernel([issue #107](https://github.com/n-riesco/ijavascript/issues/107))。isolated-vm 处于维护模式且跨 isolate 封送沉重;quickjs-emscripten 无 REPL 语义;Observable runtime 是响应式 DAG,模型不匹配。

## 机制设计:水合/脱水(hydrate/dehydrate)

模型程序原文不改写。worker 在组装 `AsyncFunction` 体时,经 acorn 解析程序,生成前奏与尾声:

```js
// 前奏(worker 生成):程序的自由标识符 ∩ state 现有 keys
let helper = state.helper;
let planIndex = state.planIndex;

'use strict';
// ---- 模型程序原文,不改写 ----
const files = await tools.grep({...});
const summary = helper(files);
// ----------------------------

// 尾声(worker 生成):本 run 顶层声明写回 state
state.files = files;
state.summary = summary;
```

解析需求(全部有参考实现):

- **自由标识符收集**:作用域分析找出"引用但未在程序内声明"的名字,只对存在于 state 的生成水合行,避免注入无关内容(借鉴 tslab 的精确性思想,acorn 作用域分析近似其 checker)。
- **顶层声明收集**:含 destructuring pattern 的标识符递归收集(借鉴 Node `await.js` L97-120)。
- **行号保持**:前奏置于程序文本之前会偏移错误行号,须在异常路径修正偏移量,或采用 `await.js` 的就地改写技巧保持源码位置。
- **末尾表达式**:可选借鉴 `await.js`/tslab 捕获末尾表达式作为 completion 的技巧;v1 不做,程序仍以显式 `return` 交付结果。

## 设计决策

- **D1 保留同 realm AsyncFunction + strict**:不换执行方式,只加前奏/尾声。现有防护(原型捕获、timer 包装、hidden binding 过滤、console shim)零改动。
- **D2 `state` 仍是唯一账本**:隐式持久只是"写入账本的语法糖"。`stateOverflow` 结算检查、超限报错、下 run 剪枝路径全部不变;`delete state.x` 同时使后续水合失效,语义自然。
- **D3 重声明 = 新局部绑定 + 尾声覆写**:每个 run 的声明是自己的函数局部变量,天然无 `SyntaxError: already declared`;run 内 `const` 不可变与 TDZ 不受损——优于 typescript-notebook 的 `const`→`var` 粗暴替换。
- **D4 失败的 run 不脱水**:程序抛错时尾声不执行,失败不污染 state,与"失败是事实"的既有 policy 语义一致。不采用 try/finally 部分脱水:半成品状态比丢失更难推理。
- **D5 保留名排除**:`state`、`console`、绑定 namespace 参数名及注入的 errorClass 名不参与水合/脱水;程序顶层声明这些名字时该声明按现状保持局部,不写回。
- **D6 水合是拷贝语义**:前奏 `let x = state.x` 后,run 中途对 `state.x` 的直接写入不反映到局部 `x`,反之局部改动也只在尾声写回。与 IPython 单线程顺序执行的实际观感一致;程序内混用两种写法时以尾声覆写为准。
- **D7 parser 依赖**:引入 acorn(或 meriyah)级轻量 parser 作为运行时依赖;不引入 Babel/TS 编译器。解析失败(语法错误)按现有程序错误路径处理,不进入水合逻辑。
- **D8 配套可见性**:run 结算的 `[prime-realm]` 提示回显当前 state keys(有界截断),等价于 notebook 的变量浏览器,让模型持续"看见"自己的命名空间。此项独立于水合机制,可先行实施。

## 成本与验证

估算:acorn 依赖 + 作用域分析 + 前奏/尾声生成 + 行号修正 + 测试,数百行量级。

测试面(启动实现时展开为用例):跨 run 声明可见性;重声明覆写;destructuring/class/function 各声明形态;失败 run 不脱水;保留名排除;`maxStateEntries` 对隐式写入同样封顶;`delete state.x` 后水合失效;显式 `state.x =` 与隐式共存;错误行号正确;generation 丢失后水合自然为空。

## 维护成本评估

acorn 作用域分析的边角长尾是本方案的主要持有成本:遮蔽与闭包捕获、块级函数声明、带默认值的 destructuring、`var` 跨块提升、class 计算属性名、generator/嵌套 async、行号偏移。压测来源是模型生成的任意代码,edge case 以 issue 形式持续到达。tslab 依赖完整 TS checker 才达到精确;acorn 近似意味着这些边角由本仓库自担。生态调研"无独立库"的另一面即是:无人愿意把它维护成库。**维护者已明确表达不愿长期持有此类变换代码;这是压低本方案优先级的一等约束,不是实现细节。**

## 启动条件与顺序

阶梯按维护成本升序;每一级只在上一级被真实数据证伪后启动:

1. **已实施**:policy 显式声明 state 跨 run 存活(f8a2d62)。
2. **D8 keys 回显**(约 20 行,无 parser):run 结算提示回显 state keys,等价于变量浏览器。
3. **惯用式引导**(零 runtime 代码):policy 给出模型自写的水合/脱水惯用式——程序开头 `const { helper, planIndex } = state`,结尾 `Object.assign(state, { files, summary })`。变换由模型每次现写,边角情况归模型代码能力,runtime 不新增任何解析逻辑;与 D8 配合使用。
4. **本方案(runtime 水合/脱水)**:仅当惯用式引导后使用率仍不达标才实施——即模型"知道、看得见、被给了写法"仍不用,才值得付 parser 维护成本。
5. 本方案与 IPython 之间不存在中间升级关系:若本方案实施后人机工学仍不达标,问题必然不在持久化语法,届时重新评估而非直接引入第二运行时。

## 参考

- [nodejs/node#64034](https://github.com/nodejs/node/pull/64034) — Node REPL 切换 inspector + V8 replMode(semver-major,未发布)
- [tslab converter.ts](https://github.com/yunabe/tslab/blob/main/src/converter.ts) — exports 重写与 checker 级水合
- [JupyterLite javascript-kernel](https://github.com/jupyterlite/javascript-kernel) — meriyah + globalThis 赋值的最小实现
- Node `lib/internal/repl/await.js` — acorn 顶层声明重写参考实现
- [ijavascript#107](https://github.com/n-riesco/ijavascript/issues/107) — 裸 vm 路线的重声明故障样本
- [DevTools const redeclare 设计文档](https://docs.google.com/document/d/1NP_FnHr4WCZRp7exgUklvNiXrH3nujcfwvp2pzMQ8-0/edit) — V8 REPL mode 语义边界
