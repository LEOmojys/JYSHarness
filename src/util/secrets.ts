/**
 * 凭据环境变量的统一处理。
 *
 * 为什么单独一个模块：sandbox（子进程环境）和 MCP（外部 server 进程）都要用，
 * 但 sandbox 不能依赖 mcp，mcp 也不该依赖 sandbox —— 放在最底层 util。
 */
export const HARNESS_KEY_ENV = /^(ANTHROPIC|OPENAI|DEEPSEEK|QWEN|MOONSHOT|DASHSCOPE|GEMINI|GROQ|MISTRAL|XAI)_API_KEY$/i;

/** 通用凭据特征（用于沙箱内清空，比 provider key 更宽）。 */
export const SECRET_KEY_PATTERN = /(API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|_AUTH)/i;

/**
 * 去掉 harness 自己的 provider key。
 *
 * 任何模式下都不该把它交给子进程/第三方 server：它们不需要"我用来思考的钥匙"，
 * 而 `printenv` 或一次日志上报就足以把它写进不该写的地方。
 */
export function scrubProviderKeys(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (HARNESS_KEY_ENV.test(key)) continue;
    out[key] = value;
  }
  return out;
}
