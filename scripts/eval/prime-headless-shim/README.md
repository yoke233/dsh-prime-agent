# prime-headless-shim(评测用)

让 `dsh --profile headless` 跑 Prime preset 的测试 shim。shipped 的 headless 有两处缺口:bundle 不含 `agent-presets` 行;runner 的 `agents.create` setup 钩子从不调用 `agentPresets.mount`(而该钩子是 mount 的唯一受支持调用点)。`index.mjs` 基于官方 runner，只增加 preset mount，并在请求宿主正常退出后设置一个 unref 的 6 秒兜底退出；正常退出不受它阻塞，只有仍有活动句柄时才强制结束评测进程。上游若让 headless runner 尊重 roster 默认 preset 且能可靠退出，本 shim 即可删除。

## 用法(隔离 DSH_HOME 的主动评测)

```powershell
$env:DSH_HOME = '<隔离目录>'   # 拷入 settings.yaml、.credentials.yaml 等
# 1. 依赖借用全局 dsh 安装(pnpm link 的包从自身位置解析 import):
$root = npm root -g
foreach ($p in 'dsh-agent','dsh-llm') {
  New-Item -ItemType Junction "<本目录>\node_modules\@deepseek-ai\$p" `
    -Target "$root\@deepseek-ai\dsh\node_modules\@deepseek-ai\$p"
}
# 2. 装入 profile(shim 的 cordis.patch.yml 会禁用 shipped runner 并插入本 runner):
dsh plugin --profile headless add link:<本目录>
dsh plugin --profile headless add link:<dsh-prime-agent 检出>
# 3. profile 的 cordis.patch.yml 补 preset 系统:
#    - insert:
#        - id: agent-presets
#          name: '@deepseek-ai/dsh-agent-presets'
#          config: { default: prime }
# 4. 需要读取系统代理时:$env:NODE_USE_ENV_PROXY = '1'
dsh --profile headless "<评测任务>"
```
