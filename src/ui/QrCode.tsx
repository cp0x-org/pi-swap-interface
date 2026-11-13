/**
 * The deposit QR, drawn as one SVG path from `uqr`'s module matrix (no canvas,
 * no innerHTML). Error correction M. An expired code is blurred so it cannot
 * be scanned; a payload too long to encode renders an empty tile.
 */
import {useMemo} from "react";
import {encode} from "uqr";
import type {QrCodeProps} from "../contracts/ui";
import {cx} from "./cx";
import s from "./QrCode.module.css";

/** The QR's module matrix as SVG path data (one 1×1 square per dark module), plus its side in modules. */
export function qrPath(value: string): {d: string; modules: number} | null {
  try {
    const qr = encode(value, {ecc: "M", border: 0});
    let d = "";
    qr.data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      });
    });
    return {d, modules: qr.size};
  } catch {
    return null;
  }
}

export function QrCode({value, size = 208, expired = false, ...aria}: QrCodeProps) {
  const qr = useMemo(() => qrPath(value), [value]);
  return (
    <div
      role="img"
      aria-label={aria["aria-label"]}
      data-expired={expired || undefined}
      className={cx(s.tile, expired && s.expired)}
    >
      <svg className={s.svg} width={size} height={size} viewBox={`0 0 ${qr?.modules ?? 1} ${qr?.modules ?? 1}`} shapeRendering="crispEdges" aria-hidden="true">
        {qr ? <path className={s.dark} d={qr.d} /> : null}
      </svg>
    </div>
  );
}
