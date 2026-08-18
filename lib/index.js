/** Prime Agent-inspired RLM control plane for DeepSeek Harness. @module dsh-prime-agent */
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools';
import { registerContinual } from './continual/plugin.js';
import { registerPolicy } from './policy.js';
import { registerRealmIdentity } from './realm/identity-tool.js';
export const name = 'prime-agent';
export const inject = ['tools', 'systemPrompt'];
/** Schemastery configuration for the control plane and secondary learning layer. */
export const Config = z.object({
    stateDirectory: z.string().required(),
    refineToolName: z.string().default('prime_refine'),
    allowGlobalRefinement: z.boolean().default(false),
    requireCodeMode: z.boolean().default(true),
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
const SDK_ASYNC_BODY = 'the body of an async TypeScript function';
const SDK_REPL_CELL = 'a persistent TypeScript REPL cell';
const SDK_RETURN_RULE = '- Emit results with `return` and/or `console.log(...)`. Only what you print or return is program output. A successful tool result containing an image is attached after the run so you can inspect it on the next step; every other intermediate result stays out of the conversation, so extract just what you need.';
const SDK_COMPLETION_RULE = '- The final expression is the result; top-level `return` is invalid. `console.log(...)` still emits logs. Only logs and the final-expression result are program output. A successful tool result containing an image is attached after the run so you can inspect it on the next step; every other intermediate result stays out of the conversation, so extract just what you need.';
const RUN_CODE_DESCRIPTION = 'Execute one persistent TypeScript REPL cell against the available tools. Top-level `await` works and ordinary top-level bindings remain available to later cells. The final expression is the result; top-level `return` is invalid. Call tools as `await tools.name(args)` per the system-prompt declarations. Image-bearing subtool results are attached after the run.';
const RUN_CODE_CODE_DESCRIPTION = 'One persistent TypeScript REPL cell; use its final expression as the result, without a top-level return.';
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Keep the public Code Mode presentation aligned with Prime's REPL executor. */
function applyReplPresentation(assembly) {
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk');
    if (sdk === undefined || !sdk.text.includes(SDK_ASYNC_BODY) || !sdk.text.includes(SDK_RETURN_RULE)) {
        throw new Error('dsh-prime-agent: tools:sdk does not match the supported TypeScript Code Mode contract');
    }
    sdk.text = sdk.text
        .replace(SDK_ASYNC_BODY, SDK_REPL_CELL)
        .replace(SDK_RETURN_RULE, SDK_COMPLETION_RULE);
    assembly.tools = assembly.tools.map((tool) => {
        if (tool.name !== RUN_CODE_NAME)
            return tool;
        const properties = tool.parameters.properties;
        const code = isRecord(properties) ? properties.code : undefined;
        if (!isRecord(properties) || !isRecord(code)) {
            throw new Error('dsh-prime-agent: run_code schema does not match the supported TypeScript Code Mode contract');
        }
        return {
            ...tool,
            description: RUN_CODE_DESCRIPTION,
            parameters: {
                ...tool.parameters,
                properties: {
                    ...properties,
                    code: { ...code, description: RUN_CODE_CODE_DESCRIPTION },
                },
            },
        };
    });
    return assembly;
}
function toolName(value, fallback, field) {
    const resolved = (value ?? fallback).trim();
    if (!/^[a-z][a-z0-9_]*$/.test(resolved)) {
        throw new Error(`dsh-prime-agent: ${field} must match /^[a-z][a-z0-9_]*$/`);
    }
    return resolved;
}
function positiveLimits(defaults, partial, label) {
    const limits = { ...defaults, ...partial };
    for (const [key, value] of Object.entries(limits)) {
        if (!Number.isSafeInteger(value) || value < 1)
            throw new Error(`dsh-prime-agent: ${label}.${key} must be a positive safe integer`);
    }
    return limits;
}
/** Register the control-plane policy, learning layer, and strict Code Mode assembly invariant. */
export function apply(ctx, config) {
    const stateDirectory = config.stateDirectory.trim();
    if (stateDirectory.length === 0)
        throw new Error('dsh-prime-agent: stateDirectory must not be empty');
    const refineToolName = toolName(config.refineToolName, 'prime_refine', 'refineToolName');
    const continualLimits = positiveLimits(CONTINUAL_DEFAULTS, config.continual, 'continual');
    registerPolicy(ctx, { requireOrchestrationTools: config.requireOrchestrationTools ?? true });
    registerContinual(ctx, {
        stateDirectory: join(stateDirectory, 'continual'),
        toolName: refineToolName,
        allowGlobal: config.allowGlobalRefinement ?? false,
        limits: continualLimits,
    });
    registerRealmIdentity(ctx, { stateDirectory });
    if (config.requireCodeMode ?? true) {
        ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
            const result = await next();
            if (context.agent === undefined)
                return result;
            if (result.tools.length !== 1 || result.tools[0]?.name !== RUN_CODE_NAME) {
                // The agent id is deliberately absent: it is the session identifier the
                // realm protocol treats as sensitive, and a prompt-assembly failure is
                // not worth putting it into a host log.
                throw new Error(`dsh-prime-agent: this agent must use Code Mode; expected the sole model-visible tool to be ${RUN_CODE_NAME}`);
            }
            return applyReplPresentation(result);
        });
    }
}
export { HarnessStore, renderHarnessState } from './continual/store.js';
//# sourceMappingURL=index.js.map