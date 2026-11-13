/**
 * What the integrator mounts for the swap paths (D22): one screen, so every
 * path but `#/gallery` (the integrator's) renders the swap screen, which also
 * resolves the demo scenes (`#/demo/<scene>?demo=1`).
 */
import {SwapScreen} from "./SwapScreen";

export function Routes() {
  return <SwapScreen />;
}
