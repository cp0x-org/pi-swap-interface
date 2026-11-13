/**
 * The port registry (D15): App.tsx provides either the real modules' ports or
 * the demo ports from src/mocks; screens read them with usePorts(). Fixed for
 * the page's lifetime.
 */
import {createContext, useContext, type ReactNode} from "react";
import type {AppPorts} from "../contracts/ports";

const PortsContext = createContext<AppPorts | null>(null);

export function PortsProvider({ports, children}: {ports: AppPorts; children: ReactNode}) {
  return <PortsContext.Provider value={ports}>{children}</PortsContext.Provider>;
}

/** The app's ports. Throws outside PortsProvider (a test must wrap with demoPorts). */
export function usePorts(): AppPorts {
  const p = useContext(PortsContext);
  if (!p) throw new Error("usePorts() outside <PortsProvider>");
  return p;
}
