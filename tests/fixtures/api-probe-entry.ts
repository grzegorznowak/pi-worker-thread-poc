import { workerData } from "node:worker_threads";
import { helperInfo, helperPrompt } from "./api-probe-helper.ts";

if (workerData.importFailure) throw new Error("API probe import failed");
// Evaluation needs no API. Dependencies arrive only when main is called.
const importCompleted = true;
export const workerDefinition = workerData.mismatch ? "secondary" : "primary";
export async function main(input: string, { session }: { session: any }): Promise<string> {
  const payload = JSON.parse(input);
  const directMain = await session.sessionInfo();
  const receipt = await helperInfo(session);
  const reply = await helperPrompt(session, payload.text);
  return JSON.stringify({
    snapshot: payload.snapshot, receipt,
    output: JSON.stringify({ importCompleted, directMain, duringMain: receipt, reply }),
    fileExchange: { ...payload.filePaths, workerReadHostText: "", workerWrittenText: "" },
  });
}
