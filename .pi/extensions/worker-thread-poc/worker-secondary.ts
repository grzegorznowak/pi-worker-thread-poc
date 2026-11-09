import { session } from "./api/session.ts";
import { executeTask } from "./worker-task.ts";

export const workerDefinition = "secondary";
export async function main(input: string): Promise<string> {
  return executeTask(input, await session.sessionInfo(), (text) => [...text].reverse().join("").toUpperCase());
}
