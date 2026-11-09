// This behavior has no imports and does not know where the plugin is installed.
export const workerDefinition = "primary";
export async function main(input: string, { session }: { session: any }): Promise<string> {
  const payload = JSON.parse(input);
  const receipt = await session.sessionInfo();
  const reply = await session.prompt({ text: payload.text });
  return JSON.stringify({
    inputType: typeof input,
    payload,
    receipt,
    reply,
    apiMethods: Object.keys(session).sort(),
    frozenAPI: Object.isFrozen(session),
  });
}
