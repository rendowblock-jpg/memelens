// Placeholder screen for M3b: proves the page can reach the data layer. The real screens come in M3c.
const out = document.getElementById("out")!;

async function run(): Promise<void> {
  const overview = await window.memelens.overview({});
  if (!overview.ok) throw new Error(overview.error);
  const chain = overview.data.chains[0]?.chain;
  const feed = chain === undefined ? null : await window.memelens.feed({ chain });
  if (feed !== null && !feed.ok) throw new Error(feed.error);
  out.textContent = JSON.stringify({ overview: overview.data, feed: feed === null ? null : feed.data }, null, 2);
  document.body.dataset["state"] = "done";
}

run().catch((e: unknown) => {
  out.textContent = String(e);
  document.body.dataset["state"] = "error";
});
