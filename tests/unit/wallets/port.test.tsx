import {render, renderHook, screen, waitFor} from "@testing-library/react";
import type {ReactNode} from "react";
import {describe, expect, it} from "vitest";
import {PortsProvider} from "../../../src/config/ports";
import {DEFAULT_RUNTIME_CONFIG} from "../../../src/config/defaults";
import {setRuntimeConfig} from "../../../src/config/runtime";
import {demoPorts} from "../../../src/mocks";
import {familyOfCaip2, useConnectOptions, walletsPort} from "../../../src/wallets";
import {walletsController} from "../../../src/wallets/port";

function Probe() {
  const w = walletsPort.useWallets();
  return (
    <p data-testid="probe">
      {w.evm ? "evm" : "no-evm"} {w.solana ? "sol" : "no-sol"} {w.options.map((o) => o.id).join(",") || "none"}
    </p>
  );
}

describe("walletsPort (browser wiring, offline)", () => {
  it("boots with no wallet installed, lists TON Connect and WalletConnect when configured, and refuses signers", async () => {
    // The controller is created on first use, so the config set here is the one it reads.
    setRuntimeConfig({...DEFAULT_RUNTIME_CONFIG, walletConnect: {projectId: "0123456789abcdef"}});
    render(
      <walletsPort.Provider>
        <Probe />
      </walletsPort.Provider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("probe").textContent).toBe("no-evm no-sol tonconnect,walletconnect"),
    );
    await walletsController().evm.ready();
    await expect(walletsPort.getSigner("eip155:42161")).rejects.toMatchObject({message: "Connect an EVM wallet first.", answered: true});
    await expect(walletsPort.getSigner("ton:-239")).rejects.toMatchObject({message: "Connect a TON wallet first.", answered: true});
    expect(familyOfCaip2("eip155:42161")).toBe("evm");
  });
});

describe("useConnectOptions", () => {
  it("groups the port's options by family (demo port here)", () => {
    const wrapper = ({children}: {children: ReactNode}) => <PortsProvider ports={demoPorts}>{children}</PortsProvider>;
    const {result} = renderHook(() => useConnectOptions(), {wrapper});
    expect(result.current.evm.map((o) => o.id)).toEqual(["io.metamask", "walletconnect"]);
    expect(result.current.solana.map((o) => o.id)).toEqual(["Phantom"]);
    expect(result.current.tron.map((o) => o.id)).toEqual(["tron:org.tronlink.www"]);
    expect(result.current.ton.map((o) => o.id)).toEqual(["tonconnect"]);
    expect(result.current.near).toEqual([]);
    expect(result.current.installed).toEqual({evm: true, solana: true, tron: true, ton: false, near: false});
  });
});
