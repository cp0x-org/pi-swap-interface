// The wallet menu over the real controller, a fake TON Connect and a fake TON Connect UI (D11): "TON Connect" closes the
// menu (a modal dialog that would trap focus and block the pointer) and opens TON Connect's own modal only once the
// menu is gone; the viewer closing that modal leaves every option unlocked; an installed TON wallet connects in place.
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {useState, useSyncExternalStore} from "react";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {WalletsApi} from "../../../src/contracts/wallets";
import {ConnectSheet} from "../../../src/screens/wallets/ConnectSheet";
import {createWalletsController, type WalletsController} from "../../../src/wallets/controller";
import {controllerDeps, fakeTonConnect, fakeTonConnectUI} from "./fakes";

function Menu({c, onClose}: {c: WalletsController; onClose(): void}) {
  const state = useSyncExternalStore(c.subscribe, c.getState);
  const [open, setOpen] = useState(true);
  const api: WalletsApi = {...state, connect: c.connect, disconnect: c.disconnect};
  return (
    <>
      <button type="button" data-testid="reopen" onClick={() => setOpen(true)} />
      <ConnectSheet
        open={open}
        focus="ton"
        wallets={api}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
      />
    </>
  );
}

const option = (id: string) => screen.getByTestId(`swap-connect-${id}`) as HTMLButtonElement;

afterEach(cleanup);

describe("the wallet menu's TON section", () => {
  it("TON Connect closes the menu, then opens TON Connect's modal; closing that modal leaves every option unlocked", async () => {
    const ton = fakeTonConnect();
    const ui = fakeTonConnectUI();
    const c = createWalletsController(controllerDeps({loadTonConnect: ton.load, loadTonConnectUI: ui.load}));
    const onClose = vi.fn();
    render(<Menu c={c} onClose={onClose} />);

    expect(option("tonconnect").textContent).toContain("Tonkeeper, MyTonWallet and other TON wallets");
    fireEvent.click(option("tonconnect"));
    expect(onClose).toHaveBeenCalledTimes(1);
    // Nothing connects while the menu is still on screen.
    expect(c.getState().connecting).toBeNull();
    await waitFor(() => expect(screen.queryByTestId("swap-connect")).toBeNull());
    await waitFor(() => expect(ui.state().status).toBe("opened"));
    expect(c.getState()).toMatchObject({connecting: "tonconnect", pairingUri: null});

    ui.close();
    await waitFor(() => expect(c.getState().connecting).toBeNull());
    expect(c.getState()).toMatchObject({ton: null, error: null});
    fireEvent.click(screen.getByTestId("reopen"));
    expect(option("tonconnect").disabled).toBe(false);
    expect(screen.queryByTestId("swap-connect-error")).toBeNull();
  });

  it("an installed TON wallet connects in place, without TON Connect's modal; closing the menu then leaves it connected", async () => {
    const ton = fakeTonConnect();
    const ui = fakeTonConnectUI();
    const c = createWalletsController(controllerDeps({loadTonConnect: ton.load, loadTonConnectUI: ui.load, tonInjected: (k) => k === "tonkeeper"}));
    const onClose = vi.fn();
    render(<Menu c={c} onClose={onClose} />);

    expect(option("tonconnect:tonkeeper").textContent).toContain("Installed");
    fireEvent.click(option("tonconnect:tonkeeper"));
    await screen.findByTestId("swap-wallet-ton");
    expect(onClose).not.toHaveBeenCalled();
    expect(ui.load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("sheet-close"));
    expect(ton.disconnect).not.toHaveBeenCalled();
    expect(c.getState().ton).not.toBeNull();
  });
});
