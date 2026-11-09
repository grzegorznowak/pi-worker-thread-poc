import type { HostReceipt, PromptReply } from "../contracts.ts";
import { boundSession } from "../session-binding.ts";

/** Selected host capabilities, not Pi's ExtensionAPI or a new AgentSession. */
export interface WorkerSession {
  sessionInfo(): Promise<HostReceipt>;
  prompt(input: { text: string }): Promise<PromptReply>;
}

// Native ESM shares this object across imports within ONE Worker isolate.
// Each fresh Worker gets its own module state and one lifetime binding.
export const session: Readonly<WorkerSession> = Object.freeze({
  async sessionInfo() { return boundSession().sessionInfo(); },
  async prompt(input: { text: string }) { return boundSession().prompt(input); },
});
