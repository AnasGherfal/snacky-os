"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Row = Record<string, any>;
type Snapshot = {
  manager: boolean;
  currentPersonId: string | null;
  selectedPersonId: string | null;
  team: Row[];
  products: Row[];
  balances: Row[];
  purchases: Row[];
  payments: Row[];
  advances: Row[];
  expenses: Row[];
  returns: Row[];
};
type Props = { initialPersonId?: string; lockPerson?: boolean };
type Tab = "overview" | "purchase" | "expense" | "history";

const money = (value: unknown) => `${Number(value ?? 0).toFixed(2)} LYD`;
const nowLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export default function OperatorMoneyLedgerClient({ initialPersonId = "", lockPerson = false }: Props) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [personId, setPersonId] = useState(initialPersonId);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState("");
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<Tab>("overview");

  const load = useCallback(async (id?: string) => {
    setLoading(true);
    const target = id || initialPersonId;
    const response = await fetch(`/api/operator-money${target ? `?personId=${target}` : ""}`, { cache: "no-store" });
    const json = await response.json();
    setLoading(false);
    if (!response.ok) {
      setMessage(json.error || "Could not load money records");
      return;
    }
    setData(json);
    setPersonId(json.selectedPersonId || target || json.currentPersonId || json.team?.[0]?.id || "");
  }, [initialPersonId]);

  useEffect(() => { void load(initialPersonId); }, [initialPersonId, load]);

  const post = async (action: string, body: Row) => {
    setSaving(action);
    setMessage("");
    const response = await fetch("/api/operator-money", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, personId, ...body, clientSubmissionId: body.clientSubmissionId || `${action}:${crypto.randomUUID()}` }),
    });
    const json = await response.json();
    setSaving("");
    if (!response.ok) {
      setMessage(json.error || "Save failed");
      return false;
    }
    setMessage(action === "purchase" ? "Purchase recorded and added to your personal balance." : "Expense submitted for review.");
    await load(personId);
    return true;
  };

  const balance = useMemo(() => data?.balances.find((row) => row.person_id === personId), [data, personId]);
  if (loading && !data) return <div className="surface-card p-5">Loading My Money…</div>;
  if (!data) return <div className="surface-card border-red-200 p-5 text-red-700">{message || "Money records are unavailable."}</div>;

  const selfService = !data.manager;
  const tabs: { id: Tab; label: string }[] = selfService
    ? [
        { id: "overview", label: "Overview" },
        { id: "purchase", label: "Buy from storage" },
        { id: "expense", label: "Submit expense" },
        { id: "history", label: "My history" },
      ]
    : [
        { id: "overview", label: "Overview" },
        { id: "history", label: "History & review" },
      ];

  return <div id="my-money" className="space-y-4">
    {data.manager && !lockPerson ? <div className="surface-card p-4">
      <label className="text-sm font-semibold">Operator</label>
      <select className="input mt-2" value={personId} onChange={(event) => { setPersonId(event.target.value); void load(event.target.value); }}>
        {data.team.map((person) => <option key={person.id} value={person.id}>{person.full_name}</option>)}
      </select>
    </div> : null}

    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white p-1">
      <div className="flex min-w-max gap-1">
        {tabs.map((item) => <button key={item.id} type="button" onClick={() => setTab(item.id)} className={`rounded-lg px-4 py-2 text-sm font-semibold ${tab === item.id ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>{item.label}</button>)}
      </div>
    </div>

    {message ? <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm">{message}</div> : null}

    {tab === "overview" ? <Overview balance={balance} data={data} personId={personId} selfService={selfService} onTab={setTab} post={post} saving={saving} /> : null}
    {tab === "purchase" && selfService ? <PurchasePanel products={data.products} saving={saving === "purchase"} onPost={post} /> : null}
    {tab === "expense" && selfService ? <ExpensePanel advances={data.advances.filter((row) => row.person_id === personId)} saving={saving === "expense"} onPost={post} /> : null}
    {tab === "history" ? <History data={data} personId={personId} manager={data.manager} post={post} /> : null}
  </div>;
}

function Overview({ balance, data, personId, selfService, onTab, post, saving }: { balance?: Row; data: Snapshot; personId: string; selfService: boolean; onTab: (tab: Tab) => void; post: (action: string, body: Row) => Promise<boolean>; saving: string }) {
  return <div className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {[
        ["Personal purchases owed", balance?.personal_debt_remaining_lyd],
        ["Money received for work", balance?.advanced_lyd],
        ["Approved work expenses", balance?.approved_expenses_lyd],
        ["Money returned", balance?.returned_money_lyd],
        ["Still to account for", balance?.unaccounted_advance_lyd],
      ].map(([label, value]) => <div className="surface-card p-4" key={String(label)}><div className="text-xs text-slate-500">{label}</div><div className="mt-1 text-xl font-bold">{money(value)}</div></div>)}
    </div>

    {selfService ? <div className="grid gap-3 md:grid-cols-2">
      <button type="button" onClick={() => onTab("purchase")} className="rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm hover:border-slate-400">
        <div className="text-lg font-semibold text-slate-900">I took products for myself</div>
        <p className="mt-1 text-sm text-slate-500">Search the product, choose quantity, and confirm. The amount is added to your personal balance.</p>
        <div className="mt-4 text-sm font-semibold text-slate-900">Record purchase →</div>
      </button>
      <button type="button" onClick={() => onTab("expense")} className="rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm hover:border-slate-400">
        <div className="text-lg font-semibold text-slate-900">I paid for Snacky work</div>
        <p className="mt-1 text-sm text-slate-500">Submit fuel, supplies, repairs, or another work expense for admin review.</p>
        <div className="mt-4 text-sm font-semibold text-slate-900">Submit expense →</div>
      </button>
    </div> : <ManagerActions data={data} personId={personId} post={post} saving={saving} />}

    <RecentActivity data={data} personId={personId} />
  </div>;
}

function PurchasePanel({ products, saving, onPost }: { products: Row[]; saving: boolean; onPost: (action: string, body: Row) => Promise<boolean> }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [productId, setProductId] = useState("");
  const [price, setPrice] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const [locations, setLocations] = useState<Row[]>([]);
  const [loadingLocations, setLoadingLocations] = useState(false);

  const categories = useMemo(() => ["All", ...Array.from(new Set(products.map((product) => String(product.category || "Other"))))].slice(0, 8), [products]);
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return products.filter((product) => {
      const categoryMatches = category === "All" || String(product.category || "Other") === category;
      const text = `${product.name || ""} ${product.brand || ""} ${product.category || ""}`.toLowerCase();
      return categoryMatches && (!term || text.includes(term));
    }).slice(0, 12);
  }, [products, query, category]);
  const selected = products.find((product) => product.id === productId);

  const chooseProduct = async (product: Row) => {
    setProductId(product.id);
    setPrice(Number(product.current_selling_price_lyd ?? product.selling_price ?? 0));
    setLocations([]);
    setLoadingLocations(true);
    const response = await fetch("/api/operator-money", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "availability", productId: product.id }) });
    const json = await response.json();
    setLoadingLocations(false);
    setLocations(response.ok ? json.data ?? [] : []);
  };

  return <section className="surface-card p-4 sm:p-5">
    <div className="max-w-3xl">
      <h2 className="text-lg font-semibold">Buy products from storage</h2>
      <p className="mt-1 text-sm text-slate-500">Use this only for products you personally take. Route stock is recorded during the route.</p>

      <div className="mt-5">
        <label className="text-sm font-semibold">1. Find the product</label>
        <input className="input mt-2" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search product or brand…" autoComplete="off" />
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {categories.map((item) => <button type="button" key={item} onClick={() => setCategory(item)} className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold ${category === item ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`}>{item}</button>)}
        </div>
        <div className="mt-3 max-h-72 overflow-y-auto rounded-xl border border-slate-200">
          {!filtered.length ? <div className="p-4 text-sm text-slate-500">No matching products.</div> : filtered.map((product) => <button type="button" key={product.id} onClick={() => void chooseProduct(product)} className={`flex w-full items-center justify-between gap-3 border-b border-slate-100 p-3 text-left last:border-0 ${productId === product.id ? "bg-slate-100" : "hover:bg-slate-50"}`}>
            <div><div className="font-medium text-slate-900">{product.name}</div><div className="text-xs text-slate-500">{[product.brand, product.category].filter(Boolean).join(" · ") || "Product"}</div></div>
            <div className="shrink-0 text-sm font-semibold">{money(product.current_selling_price_lyd ?? product.selling_price)}</div>
          </button>)}
        </div>
      </div>

      {selected ? <form className="mt-5 space-y-4 rounded-xl bg-slate-50 p-4" onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const body = Object.fromEntries(new FormData(form).entries());
        void onPost("purchase", body).then((ok) => { if (ok) { setProductId(""); setQuery(""); setQuantity(1); setLocations([]); } });
      }}>
        <input type="hidden" name="productId" value={productId} />
        <div><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Selected product</div><div className="mt-1 font-semibold">{selected.name}</div></div>
        <div>
          <label className="text-sm font-semibold">2. Storage location</label>
          <select className="input mt-2" name="storageLocationId" required disabled={loadingLocations}>
            <option value="">{loadingLocations ? "Checking stock…" : "Choose storage"}</option>
            {locations.filter((row) => Number(row.available_qty) > 0).map((row) => <option value={row.storage_location_id} key={row.storage_location_id}>{row.storage_name} — {row.available_qty} available</option>)}
          </select>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="text-sm font-semibold">3. Quantity</label><input className="input mt-2" name="quantity" type="number" min="1" value={quantity} onChange={(event) => setQuantity(Math.max(1, Number(event.target.value)))} required /></div>
          <div><label className="text-sm font-semibold">Selling price</label><input className="input mt-2" name="unitPrice" type="number" min="0" step="0.01" value={price} readOnly /></div>
        </div>
        <div className="flex items-center justify-between rounded-lg bg-white p-3"><span className="text-sm text-slate-500">Total added to your balance</span><strong>{money(quantity * price)}</strong></div>
        <textarea className="input" name="note" placeholder="Optional note" />
        <button className="btn-primary w-full sm:w-auto" disabled={saving || loadingLocations}>{saving ? "Recording…" : "Confirm my purchase"}</button>
      </form> : null}
    </div>
  </section>;
}

function ExpensePanel({ advances, saving, onPost }: { advances: Row[]; saving: boolean; onPost: (action: string, body: Row) => Promise<boolean> }) {
  return <section className="surface-card p-4 sm:p-5"><div className="max-w-2xl">
    <h2 className="text-lg font-semibold">Submit a Snacky work expense</h2>
    <p className="mt-1 text-sm text-slate-500">Use this for fuel, supplies, maintenance, or other costs paid for Snacky. Admin reviews it before it counts as approved.</p>
    <form className="mt-5 grid gap-4" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = event.currentTarget; void onPost("expense", Object.fromEntries(new FormData(form).entries())).then((ok) => { if (ok) form.reset(); }); }}>
      <div className="grid gap-4 sm:grid-cols-2"><div><label className="text-sm font-semibold">Amount</label><MoneyInput /></div><div><label className="text-sm font-semibold">Date and time</label><input className="input mt-2" name="date" type="datetime-local" defaultValue={nowLocal()} required /></div></div>
      <div className="grid gap-4 sm:grid-cols-2"><div><label className="text-sm font-semibold">Expense type</label><select className="input mt-2" name="expenseType" required defaultValue=""><option value="" disabled>Choose type</option><option>Fuel</option><option>Vehicle</option><option>Machine supplies</option><option>Storage supplies</option><option>Delivery</option><option>Other</option></select></div><div><label className="text-sm font-semibold">Paid to</label><input className="input mt-2" name="supplierPayee" required placeholder="Shop, supplier, or person" /></div></div>
      <div><label className="text-sm font-semibold">Related advance</label><select className="input mt-2" name="advanceId"><option value="">No related advance</option>{advances.map((row) => <option value={row.id} key={row.id}>{row.purpose} — {money(row.amount_lyd)}</option>)}</select></div>
      <div><label className="text-sm font-semibold">What did you pay for?</label><textarea className="input mt-2" name="note" required placeholder="Explain the expense clearly" /></div>
      <div><label className="text-sm font-semibold">Receipt link</label><input className="input mt-2" name="receiptUrl" placeholder="Optional receipt URL" /></div>
      <button className="btn-primary w-full sm:w-auto" disabled={saving}>{saving ? "Submitting…" : "Submit for review"}</button>
    </form>
  </div></section>;
}

function ManagerActions({ data, personId, post, saving }: { data: Snapshot; personId: string; post: (action: string, body: Row) => Promise<boolean>; saving: string }) {
  const submit = (action: string) => (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = event.currentTarget; void post(action, Object.fromEntries(new FormData(form).entries())).then((ok) => { if (ok) form.reset(); }); };
  return <div className="grid gap-4 xl:grid-cols-3">
    <section className="surface-card p-4"><h3 className="font-semibold">Give work money</h3><form className="mt-3 space-y-2" onSubmit={submit("advance")}><MoneyInput /><input className="input" name="purpose" required placeholder="Purpose" /><input className="input" name="date" type="datetime-local" defaultValue={nowLocal()} required /><textarea className="input" name="note" placeholder="Optional note" /><button className="btn-primary" disabled={saving === "advance"}>Record advance</button></form></section>
    <section className="surface-card p-4"><h3 className="font-semibold">Record personal debt payment</h3><form className="mt-3 space-y-2" onSubmit={submit("debtPayment")}><MoneyInput /><input className="input" name="date" type="datetime-local" defaultValue={nowLocal()} required /><input className="input" name="paymentMethod" required placeholder="Payment method" /><textarea className="input" name="note" placeholder="Optional note" /><button className="btn-primary">Record payment</button></form></section>
    <section className="surface-card p-4"><h3 className="font-semibold">Record returned work money</h3><form className="mt-3 space-y-2" onSubmit={submit("advanceReturn")}><MoneyInput /><select className="input" name="advanceId"><option value="">General return</option>{data.advances.filter((row) => row.person_id === personId).map((row) => <option value={row.id} key={row.id}>{row.purpose}</option>)}</select><input className="input" name="date" type="datetime-local" defaultValue={nowLocal()} required /><input className="input" name="paymentMethod" required placeholder="Method" /><textarea className="input" name="note" placeholder="Optional note" /><button className="btn-primary">Record return</button></form></section>
  </div>;
}

function RecentActivity({ data, personId }: { data: Snapshot; personId: string }) {
  const rows = [
    ...data.purchases.filter((row) => row.person_id === personId).map((row) => ({ id: `purchase-${row.id}`, label: `Personal purchase: ${row.product?.name ?? "Product"} × ${row.quantity}`, amount: row.total_lyd, date: row.purchased_at, status: "recorded" })),
    ...data.expenses.filter((row) => row.person_id === personId).map((row) => ({ id: `expense-${row.id}`, label: `Work expense: ${row.expense_type}`, amount: row.amount_lyd, date: row.spent_at, status: row.status })),
  ].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 5);
  return <section className="surface-card p-4"><div className="flex items-center justify-between"><h3 className="font-semibold">Recent activity</h3></div>{!rows.length ? <p className="mt-3 text-sm text-slate-500">No purchases or expenses recorded yet.</p> : <div className="mt-3 divide-y divide-slate-100">{rows.map((row) => <div key={row.id} className="flex items-center justify-between gap-4 py-3"><div><div className="text-sm font-medium">{row.label}</div><div className="text-xs text-slate-500">{new Date(row.date).toLocaleString()} · {row.status}</div></div><strong className="shrink-0 text-sm">{money(row.amount)}</strong></div>)}</div>}</section>;
}

function MoneyInput() { return <input className="input mt-2" name="amount" type="number" min="0.01" step="0.01" required placeholder="Amount (LYD)" />; }

function History({ data, personId, manager, post }: { data: Snapshot; personId: string; manager: boolean; post: (action: string, body: Row) => Promise<boolean> }) {
  const purchases = data.purchases.filter((row) => row.person_id === personId);
  const expenses = data.expenses.filter((row) => row.person_id === personId);
  return <section className="surface-card p-4"><h2 className="text-lg font-semibold">Money history</h2><div className="mt-3 overflow-x-auto"><table className="min-w-full text-sm"><thead><tr className="border-b text-left text-slate-500"><th className="p-2">Type</th><th className="p-2">Details</th><th className="p-2">Amount</th><th className="p-2">Status / date</th><th className="p-2">Action</th></tr></thead><tbody>
    {purchases.map((row) => <tr key={row.id} className="border-b"><td className="p-2">Personal purchase</td><td className="p-2">{row.product?.name ?? "Product"} × {row.quantity}</td><td className="p-2">{money(row.total_lyd)}</td><td className="p-2">{new Date(row.purchased_at).toLocaleString()}</td><td /></tr>)}
    {expenses.map((row) => <tr key={row.id} className="border-b"><td className="p-2">Work expense</td><td className="p-2">{row.expense_type} — {row.supplier_payee}</td><td className="p-2">{money(row.amount_lyd)}</td><td className="p-2">{row.status}</td><td className="p-2">{manager && row.status === "submitted" ? <div className="flex gap-2"><button className="btn-secondary" onClick={() => void post("reviewExpense", { expenseId: row.id, status: "approved" })}>Approve</button><button className="btn-secondary" onClick={() => void post("reviewExpense", { expenseId: row.id, status: "rejected" })}>Reject</button></div> : null}</td></tr>)}
  </tbody></table></div></section>;
}
