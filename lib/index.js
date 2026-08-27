/** Prime Agent-inspired RLM control plane for DeepSeek Harness. @module dsh-prime-agent */
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool, renderToolsSdk } from '@deepseek-ai/dsh-tools';
import { registerApplyPatch } from './apply-patch/plugin.js';
import { registerContinual } from './continual/plugin.js';
import { registerRefineCommand } from './continual/command.js';
import { registerPolicy } from './policy.js';
import { RealmIdentityStore } from './realm/identity.js';
import { createReplBindings, REPL_TOOL_NAME } from './repl/bridge.js';
export const name = 'prime-agent';
export const inject = ['tools', 'systemPrompt', 'primeRealmRuntime'];
/** Schemastery configuration for the control plane and secondary learning layer. */
export const Config = z.object({
    stateDirectory: z.string().required(),
    allowGlobalRefinement: z.boolean().default(false),
    refinementMaxTokens: z.natural().min(256).default(4096),
    refinementMaxConversationChars: z.natural().min(1000).default(80000),
    requireOrchestrationTools: z.boolean().default(true),
    continual: z.object({
        maxEntriesPerScope: z.natural().min(1).default(64),
        maxEntryIdChars: z.natural().min(1).default(128),
        maxEntryTitleChars: z.natural().min(1).default(200),
        maxEntryContentChars: z.natural().min(1).default(4000),
        maxReferenceToolChars: z.natural().min(1).default(128),
        maxEvidenceItems: z.natural().min(1).default(12),
        maxEvidenceChars: z.natural().min(1).default(1000),
        maxEditsPerTransaction: z.natural().min(1).default(16),
        maxTransactions: z.natural().min(1).default(32),
        maxStateBytes: z.natural().min(1024).default(524288),
        maxPromptEntriesPerScope: z.natural().min(1).default(32),
        maxPromptCharsPerScope: z.natural().min(256).default(16000),
    }),
});
const CONTINUAL_DEFAULTS = {
    maxEntriesPerScope: 64,
    maxEntryIdChars: 128,
    maxEntryTitleChars: 200,
    maxEntryContentChars: 4000,
    maxReferenceToolChars: 128,
    maxEvidenceItems: 12,
    maxEvidenceChars: 1000,
    maxEditsPerTransaction: 16,
    maxTransactions: 32,
    maxStateBytes: 524288,
    maxPromptEntriesPerScope: 32,
    maxPromptCharsPerScope: 16000,
};
function positiveLimits(defaults, partial, label) {
    const limits = { ...defaults, ...partial };
    for (const [key, value] of Object.entries(limits)) {
        if (!Number.isSafeInteger(value) || value < 1)
            throw new Error(`dsh-prime-agent: ${label}.${key} must be a positive safe integer`);
    }
    return limits;
}
const REPL_AGENT_PROMPT = `## Persistent TypeScript REPL

Call only \`repl\` directly. In the TypeScript code passed to \`repl\`, use the
preloaded \`tools.*\`, \`agents.*\`, and \`jobs.*\` APIs. Follow each generated
declaration and its comments. \`import\` and \`require\` are unavailable.

Top-level \`await\` works; top-level \`return\` does not. Variables remain available
while the REPL is active. A parse failure executes nothing; fix the cell and retry.
Pass TypeScript object literals, writing identifier keys as \`key: 'value'\`, not
\`key': 'value'\`. Tool results are parsed JavaScript values; do not call
\`JSON.parse\` on them. Inspect uncertain shapes with \`Array.isArray(value)\` and
\`Object.keys(value)\`.

\`$_\` is the latest available result; call \`$out(id)\` for an older one. Continue
from variables or these values instead of parsing shortened display text. Backslashes
in JSON previews are notation, not extra characters. Prefer forward-slash Windows
paths such as \`D:/work/project\`.

Keep large source material in files and only compact working state in the REPL.`;
const TOOL_AGENT_GUIDANCE = {
    edit: 'Read the current file before editing; after a stale-file error, read it again before retrying.',
    grep: 'Use strings for plain text. For regex syntax, pass a no-flags literal `.source`, for example `pattern: /stream\\(options\\)/.source`. Run unrelated searches as separate parallel calls; simplify a rejected pattern before retrying.',
    write: 'Use this for file creation or complete replacement; prefer edit for targeted changes. Read an existing file before overwriting it.',
};
const COMPLETION_INTRINSICS = `declare const $_: unknown

declare function $out(id: number): unknown

declare namespace $out {
  function list(): Array<{
    id: number
    type: string
    bytes?: number
    nodes?: number
    opaque?: boolean
  }>
  function drop(id: number): boolean
  function clear(): void
}`;
function namespaceDeclaration(global, aliases) {
    if (aliases.length === 0)
        return undefined;
    const members = aliases.map(({ member, target }) => `  ${member}: (args: ToolArgsMap[${JSON.stringify(target)}]) => Promise<ToolOutputMap[${JSON.stringify(target)}]>;`);
    return `declare const ${global}: {\n${members.join('\n')}\n}`;
}
function sdkText(ctx, agent) {
    const schemas = ctx.tools.schemas(agent)
        .filter(schema => schema.name !== REPL_TOOL_NAME)
        .map((schema) => {
        const definition = ctx.tools.get(schema.name, agent);
        if (definition === undefined)
            throw new Error(`dsh-prime-agent: capability disappeared during prompt assembly: ${schema.name}`);
        const guidance = TOOL_AGENT_GUIDANCE[schema.name];
        const description = guidance === undefined
            ? schema.description
            : `${schema.description}\n\n${guidance}`;
        return { ...schema, description, output: definition.output.schema };
    });
    const available = new Set(schemas.map(schema => schema.name));
    const agents = [
        available.has('subagent')
            ? { member: 'spawn', target: 'subagent' }
            : available.has('subagent_fork') ? { member: 'spawn', target: 'subagent_fork' } : undefined,
        available.has('subagent_fork') ? { member: 'fork', target: 'subagent_fork' } : undefined,
        available.has('list_agents') ? { member: 'list', target: 'list_agents' } : undefined,
        available.has('send_message') ? { member: 'send', target: 'send_message' } : undefined,
        available.has('interrupt_agent') ? { member: 'interrupt', target: 'interrupt_agent' } : undefined,
    ].filter((alias) => alias !== undefined);
    const jobs = [
        available.has('job_list') ? { member: 'list', target: 'job_list' } : undefined,
        available.has('job_output') ? { member: 'output', target: 'job_output' } : undefined,
        available.has('job_kill') ? { member: 'kill', target: 'job_kill' } : undefined,
    ].filter((alias) => alias !== undefined);
    const rendered = renderToolsSdk(schemas);
    const declarationStart = rendered.indexOf('```ts\n');
    const declarationEnd = rendered.lastIndexOf('\n```');
    if (declarationStart < 0 || declarationEnd < declarationStart) {
        throw new Error('dsh-prime-agent: generated tools SDK has an unsupported shape');
    }
    const declarations = [
        rendered.slice(declarationStart + '```ts\n'.length, declarationEnd),
        COMPLETION_INTRINSICS,
        namespaceDeclaration('agents', agents),
        namespaceDeclaration('jobs', jobs),
    ].filter((section) => section !== undefined);
    return `${REPL_AGENT_PROMPT}\n\nAvailable functions and values:\n\n\`\`\`ts\n${declarations.join('\n\n')}\n\`\`\``;
}
function projectionFrom(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !('projection' in value))
        return undefined;
    return value.projection;
}
function previewSection(value) {
    const projection = projectionFrom(value);
    return projection === undefined ? '' : `\n\nPreview:\n${JSON.stringify(projection, null, 2)}`;
}
function renderResult(value, presentation) {
    if (value === undefined)
        return undefined;
    if (presentation === undefined || presentation.kind === 'full') {
        return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    }
    if (presentation.kind === 'retained-preview') {
        return 'The complete value remains in this REPL as `$_`.\n'
            + `For older access, use \`$out(${String(presentation.handle)})\`.\n`
            + `Type: ${presentation.valueType}`
            + (presentation.serializedBytes === undefined ? '' : `\nSerialized size: ${presentation.serializedBytes.toLocaleString('en-US')} bytes`)
            + previewSection(value);
    }
    if (presentation.kind === 'unretained-preview') {
        const reason = presentation.reason ?? 'the completion history budget was exceeded';
        return `The complete value was not retained: ${reason}.\n`
            + 'This preview is not the original value. Recompute it or load it from a durable file.\n'
            + `Type: ${presentation.valueType}`
            + (presentation.serializedBytes === undefined ? '' : `\nSerialized size: ${presentation.serializedBytes.toLocaleString('en-US')} bytes`)
            + previewSection(value);
    }
    return 'The value remains in this REPL as `$_`.\n'
        + `For older access, use \`$out(${String(presentation.handle)})\`.\n`
        + `Type: ${presentation.valueType}\n`
        + 'No structural preview is available.';
}
/** Render a canonical REPL result as notebook-style model text without changing its programmatic value. */
export function renderReplResult(value) {
    const sections = [];
    if (value.logs.length > 0)
        sections.push(value.logs.join('\n'));
    const result = renderResult(value.result, value.presentation);
    if (result !== undefined)
        sections.push(result);
    return sections.join('\n\n');
}
/** Register the sole model-visible REPL and its hidden host capabilities. */
export function apply(ctx, config) {
    const stateDirectory = config.stateDirectory.trim();
    if (stateDirectory.length === 0)
        throw new Error('dsh-prime-agent: stateDirectory must not be empty');
    const continualLimits = positiveLimits(CONTINUAL_DEFAULTS, config.continual, 'continual');
    const identity = new RealmIdentityStore({ directory: join(stateDirectory, 'realm-identity') });
    const allowGlobalRefinement = config.allowGlobalRefinement ?? false;
    const refinementMaxTokens = config.refinementMaxTokens ?? 4096;
    const refinementMaxConversationChars = config.refinementMaxConversationChars ?? 80000;
    const continual = registerContinual(ctx, {
        stateDirectory: join(stateDirectory, 'continual'),
        allowGlobal: allowGlobalRefinement,
        limits: continualLimits,
        maxTokens: refinementMaxTokens,
        maxConversationChars: refinementMaxConversationChars,
    });
    registerRefineCommand(ctx, continual.store, {
        allowGlobal: allowGlobalRefinement,
        limits: continualLimits,
        maxTokens: refinementMaxTokens,
        maxConversationChars: refinementMaxConversationChars,
    });
    ctx.tools.register(defineTool({
        name: REPL_TOOL_NAME,
        description: 'Execute a TypeScript REPL cell.',
        parameters: { code: { type: 'string', required: true, description: 'TypeScript source code for this cell.' } },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    logs: { type: 'array', required: true, items: { type: 'string' } },
                    result: { type: 'json' },
                    presentation: {
                        oneOf: [
                            {
                                type: 'object',
                                additionalProperties: false,
                                properties: { kind: { type: 'string', const: 'full', required: true } },
                            },
                            {
                                type: 'object',
                                additionalProperties: false,
                                properties: {
                                    kind: { type: 'string', const: 'retained-preview', required: true },
                                    valueType: { type: 'string', required: true },
                                    serializedBytes: { type: 'integer' },
                                    handle: { type: 'integer', required: true },
                                },
                            },
                            {
                                type: 'object',
                                additionalProperties: false,
                                properties: {
                                    kind: { type: 'string', const: 'unretained-preview', required: true },
                                    valueType: { type: 'string', required: true },
                                    serializedBytes: { type: 'integer' },
                                    reason: { type: 'string' },
                                },
                            },
                            {
                                type: 'object',
                                additionalProperties: false,
                                properties: {
                                    kind: { type: 'string', const: 'opaque-reference', required: true },
                                    valueType: { type: 'string', required: true },
                                    handle: { type: 'integer', required: true },
                                },
                            },
                        ],
                    },
                },
            },
            render: (_args, value) => [{ type: 'text', text: renderReplResult(value) }],
        },
        async execute(args, exec) {
            if (exec.agent === undefined)
                throw new Error('repl requires an owning agent session');
            let realmId;
            try {
                realmId = await identity.resolve(String(exec.agent.id));
            }
            catch {
                throw new Error('repl session identity is unavailable');
            }
            const leased = createReplBindings(ctx, exec, [continual.bindingFor(exec.agent)]);
            try {
                const outcome = await ctx.primeRealmRuntime.run(realmId, { program: args.code, bindings: leased.bindings, signal: exec.signal });
                if (outcome.error !== undefined) {
                    const logs = outcome.logs.length === 0 ? '' : `\n${outcome.logs.join('\n')}`;
                    throw new Error(`repl cell failed (${outcome.error.kind}): ${outcome.error.message}${logs}`);
                }
                return {
                    logs: outcome.logs,
                    ...(outcome.value === undefined ? {} : { result: outcome.value }),
                    ...(outcome.presentation === undefined ? {} : { presentation: outcome.presentation }),
                };
            }
            finally {
                await leased.finish();
            }
        },
    }));
    registerApplyPatch(ctx);
    registerPolicy(ctx, { requireOrchestrationTools: config.requireOrchestrationTools ?? true });
    ctx.tools.guard(exec => exec.parent === undefined && exec.name !== REPL_TOOL_NAME
        ? `Call repl directly. Inside its code, invoke tools.${exec.name}(args); ${exec.name} is not directly callable in this session.`
        : undefined);
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const result = await next();
        if (context.agent === undefined)
            return result;
        const repl = result.tools.find(tool => tool.name === REPL_TOOL_NAME);
        if (repl === undefined)
            throw new Error('dsh-prime-agent: repl tool is unavailable');
        result.tools = [repl];
        result.sections = result.sections.filter(section => section.name !== 'harness:identity' && !section.name.startsWith('tool:'));
        const text = sdkText(ctx, context.agent);
        const sdk = result.sections.find(section => section.name === 'tools:sdk');
        if (sdk === undefined)
            result.sections.push({ name: 'tools:sdk', text });
        else
            sdk.text = text;
        return result;
    });
}
export { HarnessStore, renderHarnessState } from './continual/store.js';
//# sourceMappingURL=index.js.map