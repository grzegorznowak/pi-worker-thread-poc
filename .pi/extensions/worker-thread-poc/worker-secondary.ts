import type { WorkerInput } from "./contracts.ts";
import { session } from "./sdk/session.ts";
import { executeTask } from "./worker-task.ts";

export const workerDefinition = "secondary";
export async function main(input: WorkerInput) {
  return executeTask(input, await session.sessionInfo(), (text) => [...text].reverse().join("").toUpperCase());
}
