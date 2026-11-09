import { workerData } from "node:worker_threads";
import type { WorkerInput, WorkerOutput } from "../../.pi/extensions/worker-thread-poc/contracts.ts";
import { session } from "../../.pi/extensions/worker-thread-poc/sdk/session.ts";
import { helperInfo, helperSession } from "./sdk-probe-helper.ts";

if (workerData.importFailure) throw new Error("SDK probe import failed");
// Real dynamic module evaluation calls the already-bound facade, before main().
const duringImport = await session.sessionInfo();
export const workerDefinition = workerData.mismatch ? "secondary" : "primary";
export async function main(input: WorkerInput): Promise<WorkerOutput> {
  const receipt = await helperInfo();
  const reply = await session.prompt({ text: input.text });
  return {
    snapshot: input.snapshot, receipt,
    output: JSON.stringify({ duringImport, duringMain: receipt, sharedImport: session === helperSession, reply }),
    fileExchange: { ...input.filePaths, workerReadHostText: "", workerWrittenText: "" },
  };
}
