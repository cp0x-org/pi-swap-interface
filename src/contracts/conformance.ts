/**
 * Compile-time check that every module's public entry still matches its
 * contract (modules.ts). Typechecked with the app (tsc -p tsconfig.app.json),
 * never imported at runtime — importing it would pull every module in.
 * A failure here means a module's index.ts dropped or changed an export
 * another module builds against: fix the module, or agree a contract change.
 */
import * as activity from "../activity";
import * as catalog from "../catalog";
import * as execute from "../execute";
import * as screens from "../screens";
import * as swap from "../swap";
import * as ui from "../ui";
import * as wallets from "../wallets";
import type {
  ActivityModule,
  CatalogModule,
  ExecuteModule,
  ScreensModule,
  SwapModule,
  UiModule,
  WalletsModule,
} from "./modules";

export const conformance = {
  catalog: catalog satisfies CatalogModule,
  wallets: wallets satisfies WalletsModule,
  swap: swap satisfies SwapModule,
  execute: execute satisfies ExecuteModule,
  activity: activity satisfies ActivityModule,
  ui: ui satisfies UiModule,
  screens: screens satisfies ScreensModule,
};
