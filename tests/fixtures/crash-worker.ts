// TEST ONLY: an uncaught exception must kill only this Worker, not its host.
import { parentPort } from "node:worker_threads";
if (!parentPort) throw new Error("TEST ONLY fixture must run in a Worker");
parentPort.on("message", () => { throw new Error("Intentional uncaught Worker fixture failure"); });
