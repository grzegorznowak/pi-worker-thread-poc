import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isMainThread, parentPort, threadId } from "node:worker_threads";
import { RpcPeer } from "./rpc.ts";
import { shutdownMessage, type HostAPI, type WorkerAPI, type WorkerDefinitionName } from "./contracts.ts";

// Called inside the actual entry module. Functions stay in this isolate, never in IPC.
export function startWorker(definition: {
  name: WorkerDefinitionName;
  transform: (text: string) => string;
}): void {
  if (isMainThread || !parentPort) throw new Error("Start a worker entry with node:worker_threads.Worker");
  const port = parentPort;
  const rpc: RpcPeer<HostAPI, WorkerAPI> = new RpcPeer<HostAPI, WorkerAPI>(
    (message) => port.postMessage(message),
    {
      async run({ text, snapshot, mode, filePaths }) {
        // Host awaits run(); this independent reverse request must still complete.
        const receipt = await rpc.call("sessionInfo", {
          workerDefinition: definition.name,
          workerPid: process.pid,
          workerThreadId: threadId,
          workerIsMainThread: isMainThread,
          message: `Worker received ${JSON.stringify(text)}; requesting live Pi session data`,
        });
        if (mode === "fail") throw new Error("Intentional worker failure");
        // In a worker, process.exit ends this thread, not the Pi process.
        if (mode === "crash") process.exit(7);
        if (mode === "timeout") return await new Promise<never>(() => {});
        const workerReadHostText = await readFile(filePaths.hostPath, "utf8");
        const workerWrittenText = `pi-worker-thread-poc worker test ${randomUUID()}\n`;
        await writeFile(filePaths.workerPath, workerWrittenText, { encoding: "utf8", mode: 0o600, flag: "wx" });
        const promptReply = mode === "prompt"
          ? await rpc.call("prompt", { text: "hello world" }, 65_000)
          : undefined;
        return {
          workerDefinition: definition.name,
          workerPid: process.pid,
          workerThreadId: threadId,
          workerIsMainThread: isMainThread,
          snapshot,
          receipt,
          fileExchange: { ...filePaths, workerReadHostText, workerWrittenText },
          output: promptReply ? promptReply.text : `${definition.transform(text)} (host callback token: ${receipt.token})`,
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
}
