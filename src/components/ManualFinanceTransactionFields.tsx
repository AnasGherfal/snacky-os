"use client";

import { ArrowDownLeft, ArrowRightLeft, ArrowUpRight } from "lucide-react";
import { useMemo, useState } from "react";
import { FormField } from "@/components/ui";
import { categoryAllowedForDirection, type FinanceCategoryOption } from "@/lib/finance-categories";

type ManualFinanceDefaults = {
  transactionDate?: string | null;
  direction?: "money_in" | "money_out" | "transfer";
  accountId?: string | null;
  sourceAccountId?: string | null;
  destinationAccountId?: string | null;
  category?: string | null;
  amount?: number | string | null;
  payerText?: string | null;
  payeeText?: string | null;
  counterpartyText?: string | null;
};

const accountOptions = [
  { value: "snacky_lyd", label: "Snacky LYD", currency: "LYD" },
  { value: "snacky_usd", label: "Snacky USD", currency: "USD" },
  { value: "owner_lyd", label: "Owner / Anas LYD", currency: "LYD" },
  { value: "owner_usd", label: "Owner / Anas USD", currency: "USD" },
];

function accountCurrency(accountId: string) {
  return accountId.endsWith("_usd") ? "USD" : "LYD";
}

function labelForAccount(accountId: string) {
  return accountOptions.find((account) => account.value === accountId)?.label ?? "Snacky LYD";
}

export function ManualFinanceTransactionFields({
  categories,
  defaults = {},
}: {
  categories: FinanceCategoryOption[];
  defaults?: ManualFinanceDefaults;
}) {
  const initialDirection = defaults.direction === "money_in" || defaults.direction === "transfer" ? defaults.direction : "money_out";
  const [direction, setDirection] = useState<"money_in" | "money_out" | "transfer">(initialDirection);
  const [accountId, setAccountId] = useState(defaults.accountId ?? (direction === "money_in" ? "snacky_lyd" : "snacky_lyd"));
  const [sourceAccountId, setSourceAccountId] = useState(defaults.sourceAccountId ?? "owner_lyd");
  const [destinationAccountId, setDestinationAccountId] = useState(defaults.destinationAccountId ?? "snacky_lyd");
  const [category, setCategory] = useState(defaults.category ?? "");

  const allCategories = useMemo(
    () => (category && category !== "__new__" && !categories.some((item) => item.name === category) ? [...categories, { name: category, type: "both" as const }] : categories),
    [categories, category],
  );
  const visibleCategories = useMemo(() => allCategories.filter((item) => categoryAllowedForDirection(item, direction)), [allCategories, direction]);
  const currency = direction === "transfer" ? accountCurrency(sourceAccountId) : accountCurrency(accountId);
  const sameCurrencyDestinationOptions = accountOptions.filter((account) => account.currency === accountCurrency(sourceAccountId));
  const categoryStillVisible = category && visibleCategories.some((item) => item.name === category);
  const setDirectionAndClearCategory = (next: "money_in" | "money_out" | "transfer") => {
    setDirection(next);
    if (category && !allCategories.some((item) => item.name === category && categoryAllowedForDirection(item, next))) {
      setCategory("");
    }
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <FormField label="Date" required>
        <input name="transaction_date" type="date" defaultValue={defaults.transactionDate ?? ""} required className="field-input" />
      </FormField>
      <FormField label="Direction" required>
        <div className="grid gap-2 sm:grid-cols-3">
          {[
            { value: "money_in", label: "Money In", icon: ArrowDownLeft },
            { value: "money_out", label: "Money Out", icon: ArrowUpRight },
            { value: "transfer", label: "Transfer", icon: ArrowRightLeft },
          ].map((option) => {
            const Icon = option.icon;
            return (
              <label key={option.value} className={`flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold ${direction === option.value ? "border-[var(--snacky-primary)] bg-emerald-50 text-slate-950" : "border-slate-200 bg-white text-slate-700"}`}>
                <input
                  type="radio"
                  name="direction"
                  value={option.value}
                  checked={direction === option.value}
                  onChange={() => setDirectionAndClearCategory(option.value as typeof direction)}
                  className="sr-only"
                />
                <Icon className="h-4 w-4" />
                {option.label}
              </label>
            );
          })}
        </div>
      </FormField>
      <input type="hidden" name="currency" value={currency} />
      <input type="hidden" name="transaction_effect" value={direction === "transfer" ? "transfer" : direction === "money_in" ? "income" : "expense"} />

      {direction === "money_in" ? (
        <>
          <FormField label="Account receiving money" required>
            <select name="account_id" value={accountId} onChange={(event) => setAccountId(event.target.value)} className="field-input">
              {accountOptions.map((account) => <option key={account.value} value={account.value}>{account.label}</option>)}
            </select>
          </FormField>
          <FormField label="From / payer">
            <input name="payer_text" defaultValue={defaults.payerText ?? defaults.counterpartyText ?? ""} className="field-input" />
          </FormField>
        </>
      ) : null}

      {direction === "money_out" ? (
        <>
          <FormField label="Account paying money" required>
            <select name="account_id" value={accountId} onChange={(event) => setAccountId(event.target.value)} className="field-input">
              {accountOptions.map((account) => <option key={account.value} value={account.value}>{account.label}</option>)}
            </select>
          </FormField>
          <FormField label="Paid to">
            <input name="payee_text" defaultValue={defaults.payeeText ?? defaults.counterpartyText ?? ""} className="field-input" />
          </FormField>
        </>
      ) : null}

      {direction === "transfer" ? (
        <>
          <FormField label="From account" required>
            <select name="source_account_id" value={sourceAccountId} onChange={(event) => {
              const next = event.target.value;
              setSourceAccountId(next);
              if (accountCurrency(destinationAccountId) !== accountCurrency(next)) {
                setDestinationAccountId(accountCurrency(next) === "USD" ? "snacky_usd" : "snacky_lyd");
              }
            }} className="field-input">
              {accountOptions.map((account) => <option key={account.value} value={account.value}>{account.label}</option>)}
            </select>
          </FormField>
          <FormField label="To account" required>
            <select name="destination_account_id" value={destinationAccountId} onChange={(event) => setDestinationAccountId(event.target.value)} className="field-input">
              {sameCurrencyDestinationOptions.map((account) => <option key={account.value} value={account.value}>{account.label}</option>)}
            </select>
          </FormField>
          <input type="hidden" name="account_id" value={sourceAccountId} />
          <FormField label="Counterparty / memo">
            <input name="counterparty_text" defaultValue={defaults.counterpartyText ?? `${labelForAccount(sourceAccountId)} to ${labelForAccount(destinationAccountId)}`} className="field-input" />
          </FormField>
        </>
      ) : null}

      <FormField label="Amount" required>
        <input name="amount" type="number" step="0.01" min="0" defaultValue={defaults.amount ?? ""} required className="field-input" />
      </FormField>
      <FormField label="Category" required>
        <select name="category" value={categoryStillVisible ? category : ""} onChange={(event) => setCategory(event.target.value)} required className="field-input">
          <option value="">Select category</option>
          {visibleCategories.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
          <option value="__new__">Add new category...</option>
        </select>
      </FormField>
      {category === "__new__" || Boolean(!categoryStillVisible && category) ? (
        <FormField label="New category name" required>
          <input name="new_category_name" required className="field-input" />
        </FormField>
      ) : null}
    </div>
  );
}
