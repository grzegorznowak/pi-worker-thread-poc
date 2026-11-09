import { executeTask } from "./worker-task.ts";

export const workerDefinition = "secondary";
export async function main(input: string, { session }: { session: any }): Promise<string> {
  // Temporary edge typing avoids a plugin API import. The runner owns the typed API.
  return executeTask(input, session, await session.sessionInfo(), (text) => [...text].reverse().join("").toUpperCase());
}
