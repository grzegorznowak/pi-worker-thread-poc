import { isMainThread, threadId, type MessagePort } from "node:worker_threads";
import { createClient, RpcPeer } from "./rpc.ts";
import { bindSession, closeSession } from "./session-binding.ts";
import { shutdownMessage, type HostAPI, type WorkerAPI, type WorkerDefinitionName } from "./contracts.ts";

type Entry = {
  workerDefinition: WorkerDefinitionName;
  main(input: string): Promise<string>;
};

/** Internal infrastructure. The runtime supplies a trusted, allowlisted loader. */
export function serveWorker(port: MessagePort, selectedWorker: WorkerDefinitionName,
  loadModule: () => Promise<Entry>): void {
  const identity = { workerPid: process.pid, workerThreadId: threadId, workerIsMainThread: isMainThread };
  let closed = false;
  let ready: Promise<Entry>;
  const rpc = new RpcPeer<HostAPI, WorkerAPI>((message) => port.postMessage(message), {
    async run(input) {
      const entry = await ready;
      if (closed) throw new Error("Worker session API is closed");
      const output = JSON.parse(await entry.main(JSON.stringify(input)));
      return { ...output, ...identity, workerDefinition: entry.workerDefinition };
    },
  });
  const host = createClient(rpc, ["sessionInfo", "prompt"]);
  // Binding precedes even module evaluation. Workers and their helpers only import session.
  bindSession({
    sessionInfo: () => host.sessionInfo({ ...identity, workerDefinition: selectedWorker,
      message: "Worker requesting live Pi session data" }),
    prompt: (input) => host.prompt(input, 65_000),
  });

  function shutdown(error?: Error): void {
    if (closed) return;
    closed = true;
    closeSession();
    rpc.close(error);
    port.off("message", receive);
    port.off("messageerror", shutdown);
    port.off("close", onClose);
    port.close();
  }
  function onClose(): void { shutdown(new Error("Host message port closed")); }
  function receive(value: unknown): void {
    if (value && typeof value === "object"
      && "channel" in value && value.channel === shutdownMessage.channel
      && "kind" in value && value.kind === shutdownMessage.kind) shutdown();
    else rpc.receive(value);
  }
  port.on("message", receive);
  port.on("messageerror", shutdown);
  port.on("close", onClose);
  // Defer the loader so ready exists even if it calls back during evaluation.
  ready = Promise.resolve().then(loadModule).then((entry) => {
    if (entry.workerDefinition !== selectedWorker || typeof entry.main !== "function") {
      throw new Error(`Worker module does not match trusted selection: ${selectedWorker}`);
    }
    return entry;
  });
  // Startup errors must reach the host's Worker error/exit listeners, even before run().
  void ready.catch((error: unknown) => {
    if (closed) return; // Intentional shutdown can reject an import-time API call.
    shutdown(error instanceof Error ? error : new Error(String(error)));
    setImmediate(() => { throw error; });
  });
}
