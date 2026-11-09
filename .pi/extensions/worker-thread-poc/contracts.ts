// Structured-clone data only. The Pi API and live context remain in the host.
export const shutdownMessage = { channel: "pi-worker-thread-poc/control/1", kind: "shutdown" } as const;
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
    params: { workerPid: number; workerThreadId: number; workerIsMainThread: boolean; message: string };
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
      mode: "normal" | "fail" | "timeout" | "crash" | "prompt";
    };
    result: {
      workerPid: number;
      workerThreadId: number;
      workerIsMainThread: boolean;
      snapshot: SessionSnapshot;
      receipt: HostReceipt;
      output: string;
      promptReply?: PromptReply;
    };
  };
};
