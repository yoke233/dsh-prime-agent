import z from '@deepseek-ai/schemastery';
export const name = 'prime-agent-tool-restrictions';
export const inject = ['tools'];
export const Config = z.object({
    deny: z.array(z.string().min(1)).min(1),
});
/** Apply the preset-owned deny list to the calling Agent scope. */
export function apply(ctx, config) {
    ctx.tools.restrict({ deny: config.deny });
}
//# sourceMappingURL=tool-restrictions.js.map