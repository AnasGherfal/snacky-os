export type FinanceCategoryType = "income" | "expense" | "transfer" | "both";

export type FinanceCategoryOption = {
  id?: string | null;
  name: string;
  type: FinanceCategoryType;
};

export const DEFAULT_FINANCE_CATEGORIES: FinanceCategoryOption[] = [
  { name: "Sales Revenue", type: "income" },
  { name: "Ad Revenue", type: "income" },
  { name: "Rent", type: "expense" },
  { name: "Product Purchase", type: "expense" },
  { name: "Salary / Employee Payment", type: "expense" },
  { name: "Operator Payment", type: "expense" },
  { name: "Delivery / Transport", type: "expense" },
  { name: "Maintenance", type: "expense" },
  { name: "Machine Purchase", type: "expense" },
  { name: "Shipping", type: "expense" },
  { name: "Customs", type: "expense" },
  { name: "Marketing / Ads", type: "expense" },
  { name: "Refund", type: "both" },
  { name: "Charity", type: "expense" },
  { name: "Owner Funding", type: "transfer" },
  { name: "Owner Withdrawal", type: "transfer" },
  { name: "Bank / Exchange", type: "transfer" },
  { name: "Miscellaneous", type: "both" },
  { name: "Other", type: "both" },
];

export function categoryTypeForDirection(direction: string): FinanceCategoryType {
  if (direction === "money_in") return "income";
  if (direction === "transfer") return "transfer";
  return "expense";
}

export function categoryAllowedForDirection(category: FinanceCategoryOption, direction: string) {
  if (category.type === "both") return true;
  return category.type === categoryTypeForDirection(direction);
}
