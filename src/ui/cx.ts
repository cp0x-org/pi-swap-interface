/** Joins CSS Module class names, skipping the falsy ones (CSS Module lookups are `string | undefined`). */
export function cx(...names: ReadonlyArray<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}
