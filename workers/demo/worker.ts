import { executeTask } from "./worker-task.ts";

// Identity and behavior belong to this trusted module, not a host-supplied label.
export const workerDefinition = "primary";
export async function main(input: string, { session }: { session: any }): Promise<string> {
  // Temporary edge typing avoids a plugin API import. The runner owns the typed API.
  return executeTask(input, session, await session.sessionInfo(), (text) => text.toUpperCase());
}
