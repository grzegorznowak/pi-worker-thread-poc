// Helpers receive the API explicitly, with no plugin module dependency.
export const helperInfo = (session: any) => session.sessionInfo();
export const helperPrompt = (session: any, text: string) => session.prompt({ text });
