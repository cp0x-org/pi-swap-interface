/**
 * A swap's progress (activity swapSteps): a done step is a green check, the
 * running one spins, a stopped one is a red cross, the ones ahead are hollow;
 * a thin rail joins them. Each step also says its state in words for screen
 * readers, and the running one is the list's current step.
 */
import type {StepState} from "../contracts/activity";
import type {StepDotProps, SwapStepsProps} from "../contracts/ui";
import {cx} from "./cx";
import {Icon} from "./Icon";
import {Spinner} from "./Spinner";
import {Text} from "./Text";
import shared from "./shared.module.css";
import s from "./SwapSteps.module.css";

const SPOKEN: Record<StepState, string> = {done: "done", active: "in progress", todo: "to do", failed: "stopped"};

/** One 26 px step marker. */
export function StepDot({state}: StepDotProps) {
  return (
    <span className={cx(s.dot, s[state])} aria-hidden="true">
      {state === "active" ? <Spinner size={14} color="var(--accent)" /> : null}
      {state === "done" ? <Icon name="check" size={13} color="var(--green)" /> : null}
      {state === "failed" ? <Icon name="close" size={12} color="var(--red)" /> : null}
    </span>
  );
}

const LABEL: Record<StepState, string | undefined> = {done: undefined, active: undefined, todo: "var(--dim)", failed: "var(--red)"};

export function SwapSteps({steps, activeDetail, compact}: SwapStepsProps) {
  return (
    <ol className={cx(s.steps, compact && s.compact)} data-testid="swap-steps">
      {steps.map((st, i) => (
        <li key={st.key} className={s.step} data-testid={`swap-step-${st.key}-${st.state}`} aria-current={st.state === "active" ? "step" : undefined}>
          <span className={s.track}>
            <StepDot state={st.state} />
            {i < steps.length - 1 ? <span className={cx(s.rail, st.state === "done" && s.railDone)} aria-hidden="true" /> : null}
          </span>
          <span className={s.text}>
            <Text variant="bodyStrong" color={LABEL[st.state]}>
              {st.label}
              <span className={shared.srOnly}>, {SPOKEN[st.state]}</span>
            </Text>
            {st.state === "active" && activeDetail ? (
              <Text variant="meta" color="var(--muted)">
                {activeDetail}
              </Text>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
