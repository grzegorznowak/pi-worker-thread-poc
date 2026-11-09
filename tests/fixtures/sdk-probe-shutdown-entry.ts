import { workerData, type MessagePort } from "node:worker_threads";
import { session } from "../../.pi/extensions/worker-thread-poc/sdk/session.ts";

const probePort = workerData.probePort as MessagePort;

async function pendingRequest(request: Promise<unknown>): Promise<never> {
  try {
    await request;
    probePort.postMessage({ event: "sdk-resolved" });
    throw new Error("Pending SDK request must reject on shutdown");
  } catch (error) {
    probePort.postMessage({ event: "sdk-rejected", error: String(error) });
    throw error;
  } finally {
    probePort.close();
  }
}

if (workerData.shutdownMode === "import") await pendingRequest(session.sessionInfo());
export const workerDefinition = "primary";
export async function main(_input: string): Promise<string> {
  probePort.postMessage({ event: "main-started" });
  return pendingRequest(session.prompt({ text: "pending shutdown probe" }));
}
