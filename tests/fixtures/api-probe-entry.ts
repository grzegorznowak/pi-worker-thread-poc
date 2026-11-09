import { workerData } from "node:worker_threads";
import { session } from "../../.pi/extensions/worker-thread-poc/api/session.ts";
import { helperInfo, helperSession } from "./api-probe-helper.ts";

if (workerData.importFailure) throw new Error("API probe import failed");
// Real dynamic module evaluation calls the already-bound facade, before main().
const duringImport = await session.sessionInfo();
export const workerDefinition = workerData.mismatch ? "secondary" : "primary";
export async function main(input: string): Promise<string> {
  const payload = JSON.parse(input);
  const receipt = await helperInfo();
  const reply = await session.prompt({ text: payload.text });
  return JSON.stringify({
    snapshot: payload.snapshot, receipt,
    output: JSON.stringify({ duringImport, duringMain: receipt, sharedImport: session === helperSession, reply }),
    fileExchange: { ...payload.filePaths, workerReadHostText: "", workerWrittenText: "" },
  });
}
