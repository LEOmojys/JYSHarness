/**
 * 输出截断（工具结果、命令输出共用）。
 *
 * 为什么单独一个模块：sandbox/commands.ts 需要它，但不能 import tools/**
 * —— 那会破坏"安全原语不依赖被约束对象"的分层规则（jys check 会拦）。
 * 所以放在最底层的 util，两边都往下依赖。
 */
export const DEFAULT_MAX_OUTPUT_CHARS = 50_000;

/**
 * 保头也保尾：头 55%、尾 30%、标记 15%。
 * 只留头会丢掉"最后几行报错"，只留尾会丢掉命令和参数 —— 两边都得留。
 */
export function truncateOutput(
  content: string,
  limit = DEFAULT_MAX_OUTPUT_CHARS,
): { content: string; truncated: boolean } {
  if (limit <= 0 || content.length <= limit) return { content, truncated: false };
  const headChars = Math.floor(limit * 0.55);
  const tailChars = Math.max(1, Math.floor(limit * 0.3));
  const omitted = content.length - headChars - tailChars;
  const NL = String.fromCharCode(10);
  const marker =
    NL + NL + "[... " + omitted + " of " + content.length + " chars omitted ...]" + NL + NL;
  return {
    content: content.slice(0, headChars) + marker + content.slice(content.length - tailChars),
    truncated: true,
  };
}
