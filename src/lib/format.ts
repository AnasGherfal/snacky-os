export function lyd(value: number | null | undefined) {
  const safeValue = Number(value ?? 0);
  return `${safeValue.toLocaleString("en-US", { maximumFractionDigits: 0 })} LYD`;
}

export function pct(value: number | null | undefined) {
  const safeValue = Number(value ?? 0);
  return `${safeValue.toFixed(1)}%`;
}
