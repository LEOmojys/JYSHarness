/**
 * 工具熔断器。
 *
 * 解决的问题：一个工具连续失败（路径写错、命令不存在、MCP 挂了），模型往往会
 * 原样重试三五次，每次都是几百 token 的往返。熔断器在连续失败 3 次后短路一段时间，
 * 并在错误里明确写"别再重试这个工具，换个办法"——把预算留给真正有用的尝试。
 *
 * 只按"连续失败"计数：中间成功一次就清零，避免正常工具被偶发错误拖黑。
 */
export const BREAKER_THRESHOLD = 3;
export const BREAKER_COOLDOWN_MS = 60_000;

export interface BreakerState {
  fails: number;
  openUntil: number;
}

export class ToolHealth {
  private state = new Map<string, BreakerState>();

  /** 返回 null 表示放行；返回字符串表示短路的原因。 */
  check(name: string, now = Date.now()): string | null {
    const entry = this.state.get(name);
    if (!entry || entry.openUntil === 0) return null;
    if (now < entry.openUntil) {
      const seconds = Math.ceil((entry.openUntil - now) / 1000);
      return (
        name +
        " failed " +
        entry.fails +
        " times in a row; it is paused for " +
        seconds +
        "s. Do not retry it — fix the cause or use a different approach."
      );
    }
    // 冷却结束：放行并清零，给它重新证明自己的机会
    this.state.set(name, { fails: 0, openUntil: 0 });
    return null;
  }

  record(name: string, isError: boolean, now = Date.now()): void {
    const entry = this.state.get(name) ?? { fails: 0, openUntil: 0 };
    if (!isError) {
      this.state.set(name, { fails: 0, openUntil: 0 });
      return;
    }
    const fails = entry.fails + 1;
    if (fails >= BREAKER_THRESHOLD) {
      this.state.set(name, { fails, openUntil: now + BREAKER_COOLDOWN_MS });
      return;
    }
    this.state.set(name, { fails, openUntil: 0 });
  }

  /** 给 UI/诊断用：当前被短路的工具。 */
  open(now = Date.now()): Record<string, BreakerState> {
    const out: Record<string, BreakerState> = {};
    for (const [name, entry] of this.state) {
      if (entry.openUntil > now) out[name] = entry;
    }
    return out;
  }

  reset(): void {
    this.state.clear();
  }
}
