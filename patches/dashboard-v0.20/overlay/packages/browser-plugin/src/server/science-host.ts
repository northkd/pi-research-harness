/** Host-only extension point. Importing this entry never starts Chrome or Science. */
export type { ScienceHostOpenResult, ScienceHostView, ScienceViewHost, ScienceViewPartition, ScienceViewSubscription } from "@blackbelt-technology/pi-dashboard-shared/science-viewer.js";
export { createScienceBrowserHost, type ScienceBrowserHostDeps, type SciencePrivateCookie, type ScienceProjectBinding, type ScienceProjectPage } from "./science-browser.js";
export { createScienceChrome, type DedicatedChromeDeps } from "./science-chrome.js";
export type { ScienceReadUnavailable, ScienceReadWsAccess, ScienceReadWsDecision, ScienceReadWsFilter } from "./science-read-ws-bridge.js";
