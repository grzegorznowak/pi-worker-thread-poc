import { randomUUID } from "node:crypto";
import { Worker, isMainThread, threadId } from "node:worker_threads";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { shutdownMessage, type HostAPI, type HostReceipt, type WorkerAPI, type WorkerDefinitionName } from "./contracts.ts";
import { createFileExchange, verifyFileExchange, type PreparedFileExchange } from "./file-exchange.ts";
import { RpcPeer } from "./rpc.ts";
import { createSessionPrompter } from "./session-prompt.ts";
import { parseInvocation, workerModuleUrl } from "./worker-selection.ts";

export default function workerThreadPoc(pi: ExtensionAPI) {
  const promptSession = createSessionPrompter(pi);
  const active = new Set<() => Promise<void>>();
  pi.on("session_shutdown", async () => {
    await Promise.all([...active].map((stop) => stop()));
  });

  pi.registerCommand("worker-thread-poc", {
    description: "Thread RPC demo [--worker primary|secondary]; 'prompt' uses this session's active model",
    handler: async (args, ctx) => {
      let invocation: ReturnType<typeof parseInvocation>;
      try {
        invocation = parseInvocation(args);
      } catch (error) {
        // Reject options before creating a Worker, files, or model work.
        if (ctx.hasUI) ctx.ui.notify(`WORKER_THREAD_POC_RESULT ${JSON.stringify({
          ok: false, workerStarted: false, workerDefinitionMatches: false,
          workerReadHostFile: false, hostReadWorkerFile: false,
          error: error instanceof Error ? error.message : String(error),
        })}`, "error");
        return;
      }
      const { selectedWorker, text, mode } = invocation;
      const moduleUrl = workerModuleUrl(selectedWorker);
      const selection = { selectedWorker, workerModuleUrl: moduleUrl.href };
      let workerDefinition: WorkerDefinitionName | undefined;
      const controller = new AbortController();
      let callback: HostReceipt | undefined;
      // Pi loads index.ts through jiti. Run the worker with native erasable TS:
      // omit host execArgv loaders and explicitly override NODE_OPTIONS disabling stripping.
      const worker = new Worker(moduleUrl, {
        execArgv: ["--experimental-strip-types"],
        stdout: true, // Never forward worker console output into Pi's RPC JSONL.
      });
      worker.stdout?.resume(); // Discard output without buffering it indefinitely.
      const workerThreadId = worker.threadId; // Node resets this to -1 after exit.
      const hostIdentity = { hostPid: process.pid, hostThreadId: threadId, hostIsMainThread: isMainThread };
      const rpc = new RpcPeer<WorkerAPI, HostAPI>(
        (message) => worker.postMessage(message),
        {
          sessionInfo({ workerDefinition: actualDefinition, workerPid, workerThreadId, workerIsMainThread, message }) {
            workerDefinition = actualDefinition;
            callback = {
              ...hostIdentity,
              cwd: ctx.cwd,
              sessionId: ctx.sessionManager.getSessionId(),
              token: randomUUID(),
            };
            if (ctx.hasUI) {
              ctx.ui.setStatus("worker-thread-poc", `thread ${workerThreadId}: callback received`);
              ctx.ui.notify(`WORKER_THREAD_POC_PROGRESS ${JSON.stringify({ ...selection, workerDefinition, workerPid, workerThreadId, workerIsMainThread, message, ...callback })}`, "info");
            }
            return callback;
          },
          prompt({ text }) {
            return promptSession(ctx, text, controller.signal);
          },
        },
      );
      const fail = (error: Error) => {
        controller.abort(); // A dead worker must not leave model work running.
        rpc.close(error);
      };
      worker.on("message", rpc.receive);
      worker.on("messageerror", fail);
      worker.on("error", fail);
      let exited = false;
      const finished = new Promise<void>((resolve) => {
        worker.once("exit", (code) => {
          exited = true;
          fail(new Error(`Worker exited (code=${code})`));
          resolve();
        });
      });
      let stopping: Promise<void> | undefined;
      const stop = (): Promise<void> => stopping ??= (async () => {
        controller.abort();
        if (!exited) {
          try { worker.postMessage(shutdownMessage); }
          catch { /* Termination below is the fallback for a broken port. */ }
        }
        rpc.close();
        const killTimer = setTimeout(() => {
          // terminate() is thread-only. Keep error/exit listeners until it ends.
          void worker.terminate().catch(fail);
        }, 750);
        try { await finished; }
        finally {
          clearTimeout(killTimer);
          active.delete(stop);
          worker.off("message", rpc.receive);
          worker.off("messageerror", fail);
          worker.off("error", fail);
        }
      })();
      active.add(stop);
      let report: Record<string, unknown>;
      let preparedFiles: PreparedFileExchange | undefined;
      try {
        preparedFiles = await createFileExchange();
        if (ctx.hasUI) ctx.ui.setStatus("worker-thread-poc", `calling thread ${workerThreadId}`);
        const result = await rpc.call("run", {
          text,
          mode,
          filePaths: { hostPath: preparedFiles.hostPath, workerPath: preparedFiles.workerPath },
          snapshot: { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() },
        }, mode === "timeout" ? 750 : mode === "prompt" ? 70_000 : 5000);
        const files = await verifyFileExchange(preparedFiles, result.fileExchange);
        const reply = result.promptReply;
        workerDefinition = result.workerDefinition;
        const workerDefinitionMatches = workerDefinition === selectedWorker;
        const samePid = result.workerPid === process.pid;
        const differentThread = result.workerThreadId === workerThreadId && workerThreadId !== threadId && !result.workerIsMainThread;
        const ok = workerDefinitionMatches && samePid && differentThread && files.workerReadHostFile && files.hostReadWorkerFile
          && (!reply || (!reply.aborted && !["error", "aborted", "unknown"].includes(reply.stopReason)));
        report = { ok, ...selection, workerDefinition, workerDefinitionMatches,
          ...hostIdentity, workerPid: result.workerPid, workerThreadId,
          workerIsMainThread: result.workerIsMainThread, samePid, differentThread, callback, result, ...files };
      } catch (error) {
        report = {
          ok: false, ...selection, workerDefinition: workerDefinition ?? null,
          workerDefinitionMatches: workerDefinition === selectedWorker,
          ...hostIdentity, workerPid: process.pid, workerThreadId, callback,
          workerReadHostFile: false, hostReadWorkerFile: false, fileExchange: preparedFiles,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        await stop();
        if (ctx.hasUI) ctx.ui.setStatus("worker-thread-poc", undefined);
      }
      if (ctx.hasUI) {
        ctx.ui.notify(`WORKER_THREAD_POC_RESULT ${JSON.stringify(report)}`, report.ok ? "info" : "error");
      }
    },
  });
}
