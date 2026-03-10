import { bootContentHarness } from "./content.js";

declare global {
  var __browsercontrolRemoteOverlayCss: string | undefined;
}

bootContentHarness({
  cssTextPromise: Promise.resolve(globalThis.__browsercontrolRemoteOverlayCss ?? ""),
  forceReplace: true
});
