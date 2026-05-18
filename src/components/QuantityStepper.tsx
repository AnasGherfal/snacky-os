"use client";

type QuantityStepperProps = {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  className?: string;
  inputLabel?: string;
};

function clamp(value: number, min: number, max?: number) {
  const rounded = Math.floor(Number.isFinite(value) ? value : min);
  return Math.max(min, max === undefined ? rounded : Math.min(max, rounded));
}

export function QuantityStepper({
  value,
  min = 0,
  max,
  step = 1,
  onChange,
  disabled = false,
  className = "",
  inputLabel = "Quantity",
}: QuantityStepperProps) {
  const safeValue = clamp(value, min, max);
  const canDecrease = !disabled && safeValue > min;
  const canIncrease = !disabled && (max === undefined || safeValue < max);

  return (
    <div className={`inline-grid w-full grid-cols-[48px_minmax(64px,1fr)_48px] overflow-hidden rounded-lg border border-slate-300 bg-white ${className}`}>
      <button
        type="button"
        className="min-h-12 border-r border-slate-200 text-xl font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
        onClick={() => onChange(clamp(safeValue - step, min, max))}
        disabled={!canDecrease}
        aria-label={`Decrease ${inputLabel}`}
      >
        -
      </button>
      <input
        type="number"
        min={min}
        max={max}
        value={safeValue}
        onChange={(event) => onChange(clamp(Number(event.target.value), min, max))}
        className="min-h-12 w-full border-0 text-center text-base font-semibold text-slate-900 outline-none"
        aria-label={inputLabel}
        disabled={disabled}
      />
      <button
        type="button"
        className="min-h-12 border-l border-slate-200 text-xl font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
        onClick={() => onChange(clamp(safeValue + step, min, max))}
        disabled={!canIncrease}
        aria-label={`Increase ${inputLabel}`}
      >
        +
      </button>
    </div>
  );
}
