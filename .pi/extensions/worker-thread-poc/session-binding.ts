import type { WorkerSession } from "./sdk/session.ts";

// Internal runner-only lifecycle. This is module-local, not process-global state.
let binding: WorkerSession | undefined;
let state: "unbound" | "bound" | "closed" = "unbound";

export function bindSession(client: WorkerSession): void {
  if (state !== "unbound") throw new Error(`Worker session SDK cannot bind: ${state}`);
  binding = client;
  state = "bound";
}

export function boundSession(): WorkerSession {
  if (state !== "bound" || !binding) throw new Error(`Worker session SDK is ${state}`);
  return binding;
}

export function closeSession(): void {
  binding = undefined;
  state = "closed";
}
