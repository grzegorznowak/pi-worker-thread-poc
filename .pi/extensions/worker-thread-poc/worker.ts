import { session } from "./api/session.ts";
import { executeTask } from "./worker-task.ts";

// Identity and behavior belong to this trusted module, not a host-supplied label.
export const workerDefinition = "primary";
export async function main(input: string): Promise<string> {
  // main already runs in a bound Worker. No startWorker/setup/factory is needed.
  return executeTask(input, await session.sessionInfo(), (text) => text.toUpperCase());
}
