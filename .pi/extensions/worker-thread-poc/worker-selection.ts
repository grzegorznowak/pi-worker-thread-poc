import type { WorkerAPI, WorkerDefinitionName } from "./contracts.ts";

// Trusted built-in entries only. Never turn command text into a module path.
const entries: Record<WorkerDefinitionName, string> = {
  primary: "./worker.ts",
  secondary: "./worker-secondary.ts",
};

export function requireWorkerName(value: unknown): WorkerDefinitionName {
  if (value !== "primary" && value !== "secondary") {
    throw new Error("--worker requires primary or secondary. Usage: /worker-thread-poc [--worker primary|secondary] [text]");
  }
  return value;
}

export function workerModuleUrl(name: WorkerDefinitionName): URL {
  return new URL(entries[requireWorkerName(name)], import.meta.url);
}

export function parseInvocation(args: string): {
  selectedWorker: WorkerDefinitionName;
  text: string;
  mode: WorkerAPI["run"]["params"]["mode"];
} {
  let text = args.trim();
  let selectedWorker: WorkerDefinitionName = "primary";
  const selection = /^--worker(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(text);
  if (selection) {
    selectedWorker = requireWorkerName(selection[1]);
    text = (selection[2] ?? "").trim();
  }
  if (/(?:^|\s)--worker(?:\s|=|$)/.test(text)) {
    throw new Error("Use --worker primary|secondary once, before the text (no '=' form).");
  }
  text ||= "hello";
  const mode = text === "fail" || text === "timeout" || text === "crash" || text === "prompt" ? text : "normal";
  return { selectedWorker, text, mode };
}
