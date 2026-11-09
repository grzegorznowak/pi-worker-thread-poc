import { startWorker } from "./worker-runtime.ts";

// This entry owns the identity and behavior; the host does not send either in IPC.
startWorker({ name: "primary", transform: (text) => text.toUpperCase() });
