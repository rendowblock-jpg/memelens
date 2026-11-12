// Where an installed MemeLens looks for engine releases.
//
// The engine's source is private; only its signed binaries are published, in a public repository that holds nothing else.
// GitHub serves the files of a branch under raw.githubusercontent.com. The tree under this address is written by
// `memelens-release publish` (private engine repository, workflow "Publish engine"):
//   <base>/latest/<platform>-<arch>/manifest.json and manifest.json.sig
//   <base>/<version>/<platform>-<arch>/<file>
// Nothing is trusted because of where it came from: the updater installs a release only if its manifest is signed by a key in
// packages/sidecar/src/trust.ts, and the binary only if it has the size and SHA-256 that signed manifest names.
export const ENGINE_RELEASE: { baseUrl: string; allowedHosts: string[] } = {
  baseUrl: "https://raw.githubusercontent.com/rendowblock-jpg/memelens-engine/main",
  allowedHosts: ["raw.githubusercontent.com"],
};
