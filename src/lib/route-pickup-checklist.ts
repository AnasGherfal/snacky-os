type PickupProductRow = {
  productName: string;
  stopOrder?: number | null;
};

const MR_CRUNCH_ALIASES = ["mr crunch", "mr crunch tarboouch", "طربوش", "tarboouch"];
const DORITOS_ALIASES = ["doritos", "دوريتوس", "دورتوس", "doritos green hot", "doritos nacho"];

function normalizedProductName(name: string) {
  return name.trim().toLowerCase();
}

function matchesAlias(name: string, aliases: string[]) {
  const normalized = normalizedProductName(name);
  return aliases.some((alias) => normalized.includes(normalizedProductName(alias)));
}

export function pickupProductPriorityGroup(productName: string) {
  if (matchesAlias(productName, MR_CRUNCH_ALIASES)) return 1;
  if (matchesAlias(productName, DORITOS_ALIASES)) return 2;
  return 3;
}

export function sortPickupProductRows<T extends PickupProductRow>(rows: T[]) {
  return [...rows].sort((a, b) => {
    const groupDiff = pickupProductPriorityGroup(a.productName) - pickupProductPriorityGroup(b.productName);
    if (groupDiff) return groupDiff;
    const nameDiff = a.productName.localeCompare(b.productName);
    if (nameDiff) return nameDiff;
    return Number(a.stopOrder ?? 9999) - Number(b.stopOrder ?? 9999);
  });
}
