import { workerData, type MessagePort } from "node:worker_threads";
import { session } from "../../.pi/extensions/worker-thread-poc/api/session.ts";

const probePort = workerData.probePort as MessagePort;

async function pendingRequest(request: Promise<unknown>): Promise<never> {
  try {
    await request;
    probePort.postMessage({ event: "api-resolved" });
    throw new Error("Pending API request must reject on shutdown");
  } catch (error) {
    probePort.postMessage({ event: "api-rejected", error: String(error) });
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
