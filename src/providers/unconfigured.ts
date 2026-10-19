/**
 * Placeholder provider used when no credentials are configured yet.
 * It keeps the server (and therefore the settings UI) reachable so the user can
 * enter a key — instead of failing to start and leaving them with no way in.
 */
import type { ModelProvider, ModelRequest, StreamEvent } from "./types.ts";
import { ProviderError } from "./types.ts";

export class UnconfiguredProvider implements ModelProvider {
  readonly id = "unconfigured";
  readonly model = "未配置";
  private reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }

  async *stream(_req: ModelRequest): AsyncGenerator<StreamEvent> {
    throw new ProviderError("auth", this.reason);
  }
}
