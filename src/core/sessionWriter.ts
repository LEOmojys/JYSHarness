/**
 * 会话落盘（append-only JSONL）的写入队列。
 *
 * 单独成文件的原因：写入必须满足两条不变式，而这两条与"会话怎么跑"无关：
 *   1. **串行**：并发 appendFile 会把 JSONL 写坏（恢复出来缺一半）；
 *   2. **快照排在消息之后**：压缩检查点是"当前 this.messages 的整段快照"，
 *      如果此时队列里还排着未写的 append，那条消息会落在快照之后 ——
 *      resume 时先读快照再追加，于是出现重复消息。
 */
import type { Message } from "./types.ts";
import type { SessionStore } from "../session/store.ts";
import type { Logger } from "../util/log.ts";

export class SessionWriter {
  private chain: Promise<void> = Promise.resolve();
  private failures = 0;
  private readonly store: SessionStore;
  private readonly sessionId: string;
  private readonly logger: Logger;
  private readonly onWarning: (message: string) => void;

  constructor(
    store: SessionStore,
    sessionId: string,
    logger: Logger,
    onWarning: (message: string) => void,
  ) {
    this.store = store;
    this.sessionId = sessionId;
    this.logger = logger;
    this.onWarning = onWarning;
  }

  /** 追加一条消息（fire-and-forget 安全：内部已 catch）。 */
  append(message: Message): Promise<void> {
    this.chain = this.chain.then(async () => {
      try {
        await this.store.append(this.sessionId, message);
      } catch (err) {
        this.report("append", err);
      }
    });
    return this.chain;
  }

  /** 写压缩检查点：必须排在同一条链上（见文件头第 2 条）。 */
  compact(messages: Message[], before: number): Promise<void> {
    this.chain = this.chain.then(async () => {
      try {
        await this.store.appendCompact(this.sessionId, messages, before);
      } catch (err) {
        this.report("compact", err);
      }
    });
    return this.chain;
  }

  /** 等所有排队中的写入落盘（一轮结束时必须等）。 */
  flush(): Promise<void> {
    return this.chain;
  }

  private report(what: string, err: unknown): void {
    this.failures++;
    const message = err instanceof Error ? err.message : String(err);
    // 只喊一次：每轮都喊会把日志刷爆，反而看不见
    if (this.failures === 1) {
      const warning = "会话没有落盘（" + what + "）：" + message + "。这一轮照常进行，但重启后可能丢历史。";
      this.onWarning(warning);
      this.logger.warn(warning);
    }
  }
}
