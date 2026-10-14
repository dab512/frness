async function request(path, effect) {
  const response = await fetch(`${effect.adapterConfiguration.endpoint}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      remoteKey: effect.remoteKey,
      nativeKey: effect.policy.strategy === "idempotency-key",
      ...effect.input,
    }),
  });
  if (!response.ok) throw new Error("Remote protocol failure");
  return response.json();
}
export const writer = {
  execute: ({ effect }) => request("execute", effect),
  reconcile: ({ effect }) => request("reconcile", effect),
};
export const parent = { initialize: () => ({}), reduce: (state) => ({ state, commands: [] }) };
export function suite() {
  return true;
}
export const reload = {
  async capture() {
    return { type: null, value: null };
  },
  async restore() {},
  async ready() {},
  async dispose() {},
};
