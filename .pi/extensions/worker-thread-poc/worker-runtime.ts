import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { serveWorker } from "./worker-runner.ts";
import { workerModuleUrl, requireWorkerName } from "./worker-selection.ts";

if (isMainThread || !parentPort) throw new Error("Start the shared runner with node:worker_threads.Worker");
// Data chooses a built-in entry only, never an arbitrary URL or executable source.
const selectedWorker = requireWorkerName(workerData?.selectedWorker);
serveWorker(parentPort, selectedWorker, () => import(workerModuleUrl(selectedWorker).href));
