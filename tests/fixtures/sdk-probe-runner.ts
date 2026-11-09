import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { serveWorker } from "../../.pi/extensions/worker-thread-poc/worker-runner.ts";

if (!parentPort) throw new Error("Worker required");
if (workerData.shutdownMode === "loader") {
  const probePort = workerData.probePort as MessagePort;
  parentPort.once("close", () => probePort.postMessage({ event: "shutdown-observed" }));
  serveWorker(parentPort, "primary", async () => {
    probePort.postMessage({ event: "loader-pending" });
    await new Promise<void>((resolve) => probePort.once("message", () => resolve()));
    // Let the runner's ready/run continuations finish before closing the observer.
    setImmediate(() => {
      probePort.postMessage({ event: "loader-resolved" });
      probePort.close();
    });
    return {
      workerDefinition: "primary",
      async main(_input: string): Promise<string> {
        probePort.postMessage({ event: "main-started" });
        throw new Error("Late main must not execute");
      },
    };
  });
} else if (workerData.jsonBoundary) {
  serveWorker(parentPort, "primary", async () => ({
    workerDefinition: "primary",
    async main(input: string): Promise<string> {
      return JSON.stringify({
        inputType: typeof input,
        payload: JSON.parse(input),
        plain: { values: ["text", 42, true, null], nested: { message: "JSON, not a contract wrapper" } },
      });
    },
  }));
} else {
  serveWorker(parentPort, "primary", () => workerData.shutdownMode
    ? import("./sdk-probe-shutdown-entry.ts") : import("./sdk-probe-entry.ts"));
}
