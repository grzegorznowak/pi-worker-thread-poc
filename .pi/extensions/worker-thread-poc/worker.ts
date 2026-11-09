import { isMainThread, parentPort, threadId } from "node:worker_threads";
import { RpcPeer } from "./rpc.ts";
import { shutdownMessage, type HostAPI, type WorkerAPI } from "./contracts.ts";

if (isMainThread || !parentPort) throw new Error("Start worker.ts with node:worker_threads.Worker");
const port = parentPort;
const rpc: RpcPeer<HostAPI, WorkerAPI> = new RpcPeer<HostAPI, WorkerAPI>(
  (message) => port.postMessage(message),
  {
    async run({ text, snapshot, mode }) {
      // Host awaits run(); this independent reverse request must still complete.
      const receipt = await rpc.call("sessionInfo", {
        workerPid: process.pid,
        workerThreadId: threadId,
        workerIsMainThread: isMainThread,
        message: `Worker received ${JSON.stringify(text)}; requesting live Pi session data`,
      });
      if (mode === "fail") throw new Error("Intentional worker failure");
      // In a worker, process.exit ends this thread, not the Pi process.
      if (mode === "crash") process.exit(7);
      if (mode === "timeout") return await new Promise<never>(() => {});
      const promptReply = mode === "prompt"
        ? await rpc.call("prompt", { text: "hello world" }, 65_000)
        : undefined;
      return {
        workerPid: process.pid,
        workerThreadId: threadId,
        workerIsMainThread: isMainThread,
        snapshot,
        receipt,
        output: promptReply ? promptReply.text : `${text.toUpperCase()} (host callback token: ${receipt.token})`,
        ...(promptReply ? { promptReply } : {}),
      };
    },
  },
);

function shutdown(error?: Error): void {
  rpc.close(error);
  port.off("message", receive);
  port.close(); // No forced exit: reject pending calls, release the port, drain work.
}
function receive(value: unknown): void {
  if (value && typeof value === "object"
    && "channel" in value && value.channel === shutdownMessage.channel
    && "kind" in value && value.kind === shutdownMessage.kind) {
    shutdown();
  } else {
    rpc.receive(value);
  }
}
port.on("message", receive);
port.on("messageerror", (error: Error) => shutdown(error));
port.on("close", () => rpc.close(new Error("Host message port closed")));
