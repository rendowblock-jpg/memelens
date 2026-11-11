import type { Api } from "@memelens/service";

declare global {
  interface Window {
    /** Added by the preload script. */
    memelens: Api;
  }
}
