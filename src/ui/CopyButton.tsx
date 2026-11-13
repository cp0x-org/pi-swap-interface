/**
 * Copy a value (address, amount) to the clipboard. Confirms in place — the
 * icon turns into a check for a moment and a live region says "Copied" — and
 * says so when the browser refuses (no permission, insecure context).
 */
import {useEffect, useRef, useState} from "react";
import {IconButton} from "./Button";
import {Chip} from "./Chip";
import shared from "./shared.module.css";

/** Props of the copy control; with `label` it is a Paste-style chip, else a round icon button. */
export interface CopyButtonProps {
  value: string;
  /** Accessible name of the icon button, e.g. "Copy address". Default "Copy". */
  "aria-label"?: string;
  /** Visible text: renders the chip look ("Copy"). */
  label?: string;
  /** Icon button size, default 32. */
  size?: number;
  "data-testid"?: string;
}

type CopyState = "idle" | "copied" | "failed";

async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({value, label, size = 32, ...rest}: CopyButtonProps) {
  const [state, setState] = useState<CopyState>("idle");
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(reset.current), []);
  const onClick = () => {
    void copyText(value).then((ok) => {
      setState(ok ? "copied" : "failed");
      clearTimeout(reset.current);
      reset.current = setTimeout(() => setState("idle"), 1600);
    });
  };
  const spoken = state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy — select the text instead" : "";
  const name = rest["aria-label"] ?? "Copy";
  return (
    <>
      {label ? (
        <Chip label={state === "copied" ? "Copied" : label} onClick={onClick} data-testid={rest["data-testid"]} aria-label={label === name ? undefined : name} />
      ) : (
        <IconButton
          icon={state === "copied" ? "check" : "copy"}
          iconColor={state === "copied" ? "var(--green)" : state === "failed" ? "var(--red)" : undefined}
          iconSize={size <= 32 ? 15 : 18}
          size={size}
          variant="flat"
          aria-label={name}
          onClick={onClick}
          data-testid={rest["data-testid"]}
        />
      )}
      <span className={shared.srOnly} role="status" aria-live="polite">
        {spoken}
      </span>
    </>
  );
}
