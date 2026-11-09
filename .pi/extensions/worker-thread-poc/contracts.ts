// Structured-clone data only. The Pi API and live context remain in the host.
export type WorkerDefinitionName = "primary" | "secondary";
export const shutdownMessage = { channel: "pi-worker-thread-poc/control/1", kind: "shutdown" } as const;
export type FileExchangePaths = { hostPath: string; workerPath: string };
export type FileExchangeReceipt = FileExchangePaths & {
  workerReadHostText: string;
  workerWrittenText: string;
};
export type SessionSnapshot = { cwd: string; sessionId: string };
export type HostReceipt = SessionSnapshot & {
  hostPid: number;
  hostThreadId: number;
  hostIsMainThread: boolean;
  token: string;
};
export type PromptReply = {
  sessionId: string;
  text: string;
  stopReason: string;
  aborted: boolean;
  errorMessage?: string;
};
export type HostAPI = {
  sessionInfo: {
    params: { workerDefinition: WorkerDefinitionName; workerPid: number; workerThreadId: number; workerIsMainThread: boolean; message: string };
    result: HostReceipt;
  };
  prompt: {
    params: { text: string };
    result: PromptReply;
  };
};
export type WorkerAPI = {
  run: {
    params: {
      text: string;
      snapshot: SessionSnapshot;
      filePaths: FileExchangePaths; // Paths only: the worker must read host.txt itself.
      mode: "normal" | "fail" | "timeout" | "crash" | "prompt";
    };
    result: {
      snapshot: SessionSnapshot;
      receipt: HostReceipt;
      output: string;
      fileExchange: FileExchangeReceipt;
      promptReply?: PromptReply;
      workerDefinition: WorkerDefinitionName;
      workerPid: number;
      workerThreadId: number;
      workerIsMainThread: boolean;
    };
  };
};
