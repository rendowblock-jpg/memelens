import { ReplayAdapter, ingest, parseFixture, type Store } from "@memelens/data";
import { SampleUserError, type SampleService } from "@memelens/service";

// The one place the app writes data on a person's behalf. It exists so that a freshly installed MemeLens, which has no data
// and no real-data adapter yet, can show what it does. Three rules: it only ever fills a database that is completely empty
// (it never mixes made-up data into data someone brought), it loads the sample bundled with the app and nothing the window
// names, and a second click while the first is still working is refused.

export interface SampleDeps {
  store: Store;
  /** The bundled sample: a memelens-fixture, as parsed JSON. */
  sample: unknown;
  log: (line: string) => void;
}

export function createSampleService(deps: SampleDeps): SampleService {
  const { store, sample, log } = deps;
  let loading = false;
  return {
    async load() {
      if (loading) throw new SampleUserError("the sample is already loading");
      loading = true; // set before the first await, so a second call in the same instant is refused
      try {
        if (store.chains().length > 0) throw new SampleUserError("this database already holds data; the sample is only loaded into an empty one");
        const adapter = new ReplayAdapter(parseFixture(sample)); // a malformed sample throws here, before anything is written
        const report = await ingest(store, adapter);
        const rejected = report.tokens.rejected + report.trades.rejected + report.snapshots.rejected;
        if (rejected > 0) throw new Error(`the bundled sample had ${rejected} rejected items: ${JSON.stringify(report.rejectReasons)}`);
        log(`loaded the sample: chain ${report.chain}, ${report.tokens.inserted} tokens, ${report.trades.inserted} trades`);
        return { chain: report.chain, tokens: report.tokens.inserted, trades: report.trades.inserted };
      } finally {
        loading = false;
      }
    },
  };
}
