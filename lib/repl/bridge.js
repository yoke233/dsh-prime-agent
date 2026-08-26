import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm';
export const REPL_TOOL_NAME = 'repl';
/** Submission-ordered scheduler: parallel calls overlap until an exclusive barrier. */
class ReplDispatchQueue {
    pending = [];
    inFlight = new Set();
    exclusive = false;
    closed = false;
    enqueue(mode, operation) {
        if (this.closed)
            return Promise.reject(new Error('repl cell is over; tool call not dispatched'));
        return new Promise((resolve, reject) => {
            this.pending.push({ mode, reject, start: () => {
                    if (mode === 'exclusive')
                        this.exclusive = true;
                    let flight;
                    flight = operation().then(resolve, reject).then(() => undefined).finally(() => {
                        this.inFlight.delete(flight);
                        if (mode === 'exclusive')
                            this.exclusive = false;
                        this.pump();
                    });
                    this.inFlight.add(flight);
                } });
            this.pump();
        });
    }
    close() {
        this.closed = true;
        for (const item of this.pending.splice(0))
            item.reject(new Error('repl cell is over; queued tool call cancelled'));
    }
    async drain() {
        while (this.inFlight.size > 0)
            await Promise.allSettled([...this.inFlight]);
    }
    pump() {
        if (this.exclusive)
            return;
        while (this.pending.length > 0) {
            const head = this.pending[0];
            if (head.mode === 'exclusive') {
                if (this.inFlight.size > 0)
                    return;
                this.pending.shift();
                head.start();
                return;
            }
            this.pending.shift();
            head.start();
        }
    }
}
function forwardResult(exec, result) {
    if (!result.isError && result.content.some(block => block.type === 'image')) {
        exec.deferContext(createUserMessage({ content: result.content, source: { kind: 'plugin', plugin: 'repl' } }));
    }
    for (const context of result.additionalContexts ?? [])
        exec.deferContext(context);
    if (!result.isError && result.concludesTurn)
        exec.concludeTurn();
}
function officialPresentation(result) {
    if (result.content.length === 0)
        return undefined;
    return result.content.filter(block => block.type === 'text').map(block => block.text).join('');
}
async function dispatchLogContent(ctx, dispatch) {
    try {
        return await ctx.waterfall('tools/code-dispatch-log', dispatch, () => Promise.resolve(dispatch.content));
    }
    catch {
        return dispatch.content;
    }
}
/** Build one cell's leased host capabilities from the calling Agent's catalog. */
export function createReplBindings(ctx, exec, extraBindings = []) {
    const agent = exec.agent;
    if (agent === undefined)
        throw new Error('repl requires an owning agent session');
    const queue = new ReplDispatchQueue();
    let dispatchNumber = 0;
    let commitTail = Promise.resolve();
    const binding = (toolName) => async (argumentsValue) => {
        const subCallId = CallId(String(exec.callId) + ':repl:' + String(++dispatchNumber));
        const rootCallId = exec.rootCallId ?? exec.callId;
        const input = {
            callId: subCallId,
            rootCallId,
            name: toolName,
            arguments: argumentsValue,
            agent,
            parent: exec.token,
            signal: exec.signal,
        };
        const mode = ctx.tools.executionMode(input).kind === 'parallel' ? 'parallel' : 'exclusive';
        const previousCommit = commitTail;
        let releaseCommit;
        commitTail = new Promise(resolve => { releaseCommit = resolve; });
        try {
            const result = await queue.enqueue(mode, async () => {
                agent.session.append('tool/code-dispatch-start', {
                    rootCallId,
                    parentCallId: exec.callId,
                    subCallId,
                    name: toolName,
                    arguments: argumentsValue,
                });
                return await ctx.tools.execute(input);
            });
            await previousCommit;
            const content = await dispatchLogContent(ctx, {
                exec,
                agent,
                subCallId,
                name: toolName,
                isError: result.isError,
                content: result.content,
            });
            agent.session.append('tool/code-dispatch', {
                rootCallId,
                parentCallId: exec.callId,
                subCallId,
                name: toolName,
                arguments: argumentsValue,
                isError: result.isError,
                content,
            });
            forwardResult(exec, result);
            if (result.isError)
                throw new Error(result.error.message);
            const presentation = officialPresentation(result);
            return presentation === undefined ? result.value : {
                $dshPrimeBinding: 'presentation-v1',
                value: result.value,
                presentation,
            };
        }
        finally {
            releaseCommit();
        }
    };
    const raw = Object.create(null);
    const available = new Set();
    for (const schema of ctx.tools.schemas(exec.agent)) {
        if (schema.name === REPL_TOOL_NAME)
            continue;
        available.add(schema.name);
        Object.defineProperty(raw, schema.name, { enumerable: true, value: binding(schema.name) });
    }
    const namespace = (global, aliases) => {
        const functions = Object.create(null);
        for (const [member, target] of Object.entries(aliases)) {
            if (available.has(target))
                Object.defineProperty(functions, member, { enumerable: true, value: binding(target) });
        }
        return Object.keys(functions).length === 0 ? undefined : { global, functions };
    };
    const bindings = [{ global: 'tools', functions: raw, errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' } }];
    const agents = namespace('agents', {
        spawn: available.has('subagent') ? 'subagent' : 'subagent_fork',
        fork: 'subagent_fork', list: 'list_agents', send: 'send_message', interrupt: 'interrupt_agent',
    });
    const jobs = namespace('jobs', { list: 'job_list', output: 'job_output', kill: 'job_kill' });
    if (agents !== undefined)
        bindings.push(agents);
    if (jobs !== undefined)
        bindings.push(jobs);
    bindings.push(...extraBindings);
    return { bindings, async finish() { queue.close(); await queue.drain(); await commitTail; } };
}
//# sourceMappingURL=bridge.js.map