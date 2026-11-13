/**
 * Headless connect-menu data for the screens' ConnectSheet: the port's
 * options grouped by family. Goes through usePorts(), so it shows the demo
 * wallets in demo mode and the announced ones otherwise.
 */
import {useMemo} from "react";
import {usePorts} from "../config/ports";
import {connectOptionGroups, type ConnectOptionGroups} from "./options";

export function useConnectOptions(): ConnectOptionGroups {
  const {options} = usePorts().wallets.useWallets();
  return useMemo(() => connectOptionGroups(options), [options]);
}
