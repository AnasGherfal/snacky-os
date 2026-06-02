export type FinanceCategoryType = "income" | "expense" | "transfer" | "both";

export type FinanceCategoryOption = {
  id?: string | null;
  name: string;
  type: FinanceCategoryType;
};

export const DEFAULT_FINANCE_CATEGORIES: FinanceCategoryOption[] = [
  { name: "Revenue", type: "income" },
  { name: "Ads Income", type: "income" },
  { name: "Product Restocking", type: "expense" },
  { name: "Rent", type: "expense" },
  { name: "Salary / Employee Payment", type: "expense" },
  { name: "Operator Payment", type: "expense" },
  { name: "Commute", type: "expense" },
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
  { name: "Uncategorized", type: "both" },
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
