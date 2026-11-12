// Preloaded into the site under test (`node --import`): every server-side
// request to Discord goes to the local mock in MOCK_DISCORD instead.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith("https://discord.com/")) return realFetch(input, init);
  return realFetch(url.replace("https://discord.com", process.env.MOCK_DISCORD), init);
};
