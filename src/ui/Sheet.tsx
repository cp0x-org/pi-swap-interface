/**
 * Every popup of the swap: a centred dialog (or a right-hand drawer) at
 * ≥ 640 px via Radix Dialog, a draggable bottom sheet below via vaul. Both
 * trap focus, close on Esc / backdrop / drag, are `aria-modal`, and refuse
 * every close path while `locked` (a swap is executing).
 */
import * as Dialog from "@radix-ui/react-dialog";
import {useRef, type CSSProperties, type RefObject} from "react";
import {Drawer} from "vaul";
import type {SheetProps} from "../contracts/ui";
import {useBreakpoint} from "./breakpoint";
import {cx} from "./cx";
import shared from "./shared.module.css";
import s from "./Sheet.module.css";

/** Sheet props plus layout escape hatches the token sheet and tests need. */
export interface SheetExtraProps extends SheetProps {
  /** No padding and no scroll on the body, and a definite height (dialog min(680px, 90dvh)): the child lays itself out (token sheet's rail + virtual list). */
  flush?: boolean;
  /** Focused when the dialog opens on ≥ 640 (the token search); phones never autofocus (no surprise keyboard). */
  initialFocus?: RefObject<HTMLElement | null>;
  /**
   * Runs once the sheet has finished closing (its exit animation over, its focus trap and scroll lock gone, focus
   * back on the opener). Whatever opens next waits for it: a sheet opened from this one then hands focus back to the
   * same opener, and the wallet menu opens TON Connect's own modal here, so the two never overlap.
   */
  onClosed?(): void;
  "data-testid"?: string;
}

/** One close request: ignored while locked, and only for "close" (open is the caller's). */
function closer(locked: boolean | undefined, onClose: () => void) {
  return (next: boolean) => {
    if (!next && !locked) onClose();
  };
}

/**
 * Focus goes back where it was when the sheet opened (WCAG 2.4.3). No sheet has a Radix Dialog.Trigger, and
 * Radix's modal content (vaul's too) restores focus only to that trigger — without this, every close (Esc, Close,
 * picking a token or a route) drops focus to <body> and the next Tab starts over at the header. The opener is read in
 * onOpenAutoFocus, which runs before the dialog moves focus inside.
 */
function useReturnFocus() {
  const opener = useRef<HTMLElement | null>(null);
  return {
    capture() {
      const a = typeof document !== "undefined" ? document.activeElement : null;
      opener.current = a instanceof HTMLElement && a !== document.body ? a : null;
    },
    restore(e: Event) {
      const el = opener.current;
      opener.current = null;
      if (!el?.isConnected) return;
      e.preventDefault();
      el.focus({preventScroll: true});
    },
  };
}

export function Sheet(props: SheetExtraProps) {
  return useBreakpoint() === "phone" ? <BottomSheet {...props} /> : <DialogSheet {...props} />;
}

function DialogSheet({open, onClose, onClosed, label, locked, width, placement = "dialog", flush, initialFocus, children, ...rest}: SheetExtraProps) {
  const block = (e: Event) => {
    if (locked) e.preventDefault();
  };
  const style = width ? ({"--sheet-width": `${width}px`} as CSSProperties) : undefined;
  const focus = useReturnFocus();
  return (
    <Dialog.Root open={open} onOpenChange={closer(locked, onClose)}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} data-testid="sheet-backdrop" />
        <Dialog.Content
          data-testid={rest["data-testid"]}
          aria-modal="true"
          aria-describedby={undefined}
          className={cx(s.dialog, placement === "drawer" && s.drawer, placement === "dialog" && flush && s.dialogFull)}
          style={style}
          onEscapeKeyDown={block}
          onPointerDownOutside={block}
          onInteractOutside={block}
          onOpenAutoFocus={(e) => {
            focus.capture();
            if (!initialFocus) return;
            e.preventDefault();
            initialFocus.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            focus.restore(e);
            onClosed?.();
          }}
        >
          <Dialog.Title className={shared.srOnly}>{label}</Dialog.Title>
          <div className={flush ? s.flush : s.body}>{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function BottomSheet({open, onClose, onClosed, label, locked, phoneHeight = "tall", flush, children, ...rest}: SheetExtraProps) {
  const content = useRef<HTMLDivElement>(null);
  const focus = useReturnFocus();
  return (
    <Drawer.Root open={open} onOpenChange={closer(locked, onClose)} dismissible={!locked}>
      <Drawer.Portal>
        <Drawer.Overlay className={s.overlay} data-testid="sheet-backdrop" />
        <Drawer.Content
          ref={content}
          data-testid={rest["data-testid"]}
          aria-modal="true"
          aria-describedby={undefined}
          className={cx(s.bottom, s[phoneHeight])}
          // focus the sheet itself, not its first input: moves assistive tech inside without opening the keyboard
          onOpenAutoFocus={(e) => {
            focus.capture();
            e.preventDefault();
            content.current?.focus({preventScroll: true});
          }}
          onCloseAutoFocus={(e) => {
            focus.restore(e);
            onClosed?.();
          }}
        >
          <div className={s.grabber} aria-hidden="true" />
          <Drawer.Title className={shared.srOnly}>{label}</Drawer.Title>
          <div className={flush ? s.flush : s.body}>{children}</div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
