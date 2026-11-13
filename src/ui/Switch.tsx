/** The on/off control ("Send to another address"): a real button with role="switch", so Space/Enter toggle it. */
import type {SwitchProps} from "../contracts/ui";
import s from "./Switch.module.css";

/** Switch props plus pass-through ids for tests and label wiring. */
export interface SwitchExtraProps extends SwitchProps {
  id?: string;
  "data-testid"?: string;
  "aria-describedby"?: string;
}

export function Switch({checked, onChange, disabled, ...attrs}: SwitchExtraProps) {
  return (
    <button {...attrs} type="button" role="switch" aria-checked={checked} disabled={disabled} className={s.track} onClick={() => onChange(!checked)}>
      <span className={s.knob} aria-hidden="true" />
    </button>
  );
}
