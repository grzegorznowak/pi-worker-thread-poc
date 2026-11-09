import { workerData, type MessagePort } from "node:worker_threads";

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

probePort.postMessage({ event: "module-imported" });
export const workerDefinition = "primary";
export async function main(_input: string, { session }: { session: any }): Promise<string> {
  probePort.postMessage({ event: "main-started" });
  return pendingRequest(workerData.shutdownMode === "sessionInfo"
    ? session.sessionInfo() : session.prompt({ text: "pending shutdown probe" }));
}
