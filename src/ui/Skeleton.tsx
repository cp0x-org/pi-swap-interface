/**
 * Loading placeholders that keep the shape of what is coming — never an empty
 * slab (apps/mobile/components/Skeleton.tsx).
 */
import type {ReviewSkeletonProps, SkeletonProps} from "../contracts/ui";
import {Spinner} from "./Spinner";
import {Text} from "./Text";
import s from "./Skeleton.module.css";

/** One breathing bar; decorative, the surrounding status text names the wait. */
export function Skeleton({width = "100%", height = 14, radius = 8, style}: SkeletonProps) {
  return <span aria-hidden="true" className={s.skeleton} style={{width, height, borderRadius: radius, ...style}} />;
}

/** A review card while its quote is prepared: label-left / value-right rows plus what is happening. */
export function ReviewSkeleton({rows = 5, label}: ReviewSkeletonProps) {
  return (
    <div className={s.review} data-testid="review-loading" role="status">
      {Array.from({length: rows}, (_, i) => (
        <div key={i} className={s.row}>
          <Skeleton width={i % 2 ? 72 : 88} height={12} />
          <Skeleton width={i % 3 === 0 ? 120 : 96} height={14} />
        </div>
      ))}
      <div className={s.footer}>
        <Spinner color="var(--muted)" />
        <Text variant="meta" color="var(--muted)">
          {label}
        </Text>
      </div>
    </div>
  );
}
