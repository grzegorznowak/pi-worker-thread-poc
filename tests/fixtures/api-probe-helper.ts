import { session } from "../../.pi/extensions/worker-thread-poc/api/session.ts";

export const helperSession = session;
export const helperInfo = () => session.sessionInfo();
