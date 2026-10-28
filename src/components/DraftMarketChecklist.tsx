"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/components/I18nProvider";
import { MarketChecklist, type MarketProgressPayload } from "@/components/MarketChecklist";
import { useMarketCommand } from "@/components/SharedMarketChecklist";
import { buyingDate, buyingUuid, type BuyingWorkspace } from "@/lib/buying-lists";
import { readRestockShoppingListStrict } from "@/lib/restock-shopping-list";
import {
  marketDraftKey, marketSuggestionsKey, parseMarketDraft, validateMarketItems,
  marketItemsFromRecommendations, mergeMarketRecommendations, marketEditItem,
  type MarketChecklistItem, type MarketCommand,
} from "@/lib/market-checklist";
import styles from "./MarketChecklist.module.css";

type ListDetails = { title: string; buyer: string; due: string; instructions: string };
type PublishedDraft = { listId: string; signature: string };
function validDetails(value: unknown): value is ListDetails {
  if (!value || typeof value !== "object") return false;
  const details = value as ListDetails;
  return typeof details.title === "string" && details.title.length <= 160
    && typeof details.buyer === "string" && (!details.buyer || buyingUuid.test(details.buyer))
    && typeof details.due === "string" && (!details.due || buyingDate(details.due))
    && typeof details.instructions === "string" && details.instructions.length <= 3000;
}

export function DraftMarketChecklist({ userId, today, fromSuggestions = false }: { userId: string; today: string; fromSuggestions?: boolean }) {
  const { locale } = useLanguage(), ar = locale === "ar", router = useRouter();
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  const key = marketDraftKey(userId), detailsKey = `${key}:details`, publishedKey = `${key}:published`;
  const [items, setItems] = useState<MarketChecklistItem[]>([]), itemsRef = useRef<MarketChecklistItem[]>([]);
  const [suggestions, setSuggestions] = useState<MarketChecklistItem[]>([]);
  const [ready, setReady] = useState(false), [error, setError] = useState(""), [saveMessage, setSaveMessage] = useState("");
  const [details, setDetails] = useState<ListDetails>({ title: ar ? "قائمة السوق" : "Market shopping list", buyer: "", due: today, instructions: "" });
  const detailsRef = useRef(details);
  const detailsRestoreFailed = useRef(false);
  const [detailsError, setDetailsError] = useState("");
  const [suggestionsWarning, setSuggestionsWarning] = useState("");
  const [publicationError, setPublicationError] = useState(false);
  const [published, setPublished] = useState<PublishedDraft | null>(null);
  const [context, setContext] = useState<BuyingWorkspace | null>(null), [contextError, setContextError] = useState(false);
  const [contextAttempt, setContextAttempt] = useState(0);

  const publish = useMarketCommand({ userId, identity: "publish", onSaved: (command: MarketCommand) => {
    const saved = { listId: command.list_id, signature: JSON.stringify(command.payload) };
    setPublished(saved);
    try { localStorage.setItem(publishedKey, JSON.stringify(saved)); } catch { /* The confirmed shared list is authoritative. */ }
    router.push(`/buying-lists/${command.list_id}`);
  } });

  useEffect(() => {
    let alive = true;
    queueMicrotask(() => {
    if (!alive) return;
    try {
      const raw = localStorage.getItem(key);
      let restored = raw ? parseMarketDraft(raw).items : [];
      let suggested: MarketChecklistItem[] = [];
      try {
        const suggestedRaw = localStorage.getItem(marketSuggestionsKey(userId));
        suggested = suggestedRaw ? parseMarketDraft(suggestedRaw).items : [];
        setSuggestionsWarning("");
      } catch {
        setSuggestionsWarning(ar ? "تعذر فتح الاقتراحات الجديدة. قائمتك الحالية محفوظة ويمكنك متابعة استخدامها." : "New suggestions could not be opened. Your existing checklist is preserved and ready to use.");
      }
      if (raw === null && fromSuggestions) restored = suggested;
      if (raw === null) localStorage.setItem(key, JSON.stringify({ version: 1, items: restored }));
      itemsRef.current = restored;
      setItems(restored);
      setSuggestions(suggested);
      try {
        const savedDetails = localStorage.getItem(detailsKey);
        if (savedDetails) {
          const parsed: unknown = JSON.parse(savedDetails);
          if (!validDetails(parsed)) throw Error("details");
          detailsRef.current = parsed;
          setDetails(parsed);
        }
        detailsRestoreFailed.current = false;
      } catch {
        detailsRestoreFailed.current = true;
        setDetailsError(ar ? "تعذر استعادة اسم القائمة أو تفاصيلها. راجع التفاصيل أدناه ثم احفظها مجدداً؛ العناصر محفوظة." : "List details could not be restored. Review and save the details below again; your items are preserved.");
      }
      try {
        const savedPublication = localStorage.getItem(publishedKey);
        if (savedPublication) {
          const parsed = JSON.parse(savedPublication) as PublishedDraft;
          if (!parsed || typeof parsed.listId !== "string" || !buyingUuid.test(parsed.listId) || typeof parsed.signature !== "string") throw Error("publication");
          setPublished(parsed);
        }
      } catch {
        setPublicationError(true);
      }
      setReady(true);
    } catch {
      setError(ar ? "تعذر قراءة مسودتك المحفوظة. لم نستبدلها بقائمة فارغة. أعد التحميل أو افتح قائمتك المشتركة." : "Your saved draft could not be read. It has not been replaced with an empty list. Reload or open your shared checklist.");
    }
    });
    return () => { alive = false; };
  }, [key, detailsKey, publishedKey, userId, fromSuggestions, ar]);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    const controller = new AbortController();
    fetch("/api/buying-lists", { cache: "no-store", signal: controller.signal })
      .then(async response => { const result = await response.json(); if (!response.ok || !result.ok || !Array.isArray(result.data?.people)) throw Error("unavailable"); return result.data as BuyingWorkspace; })
      .then(data => {
        if (!alive) return;
        setContext(data);
        setContextError(false);
        if (!detailsRestoreFailed.current && !detailsRef.current.buyer && data.people.some(person => person.id === data.me)) {
          const next = { ...detailsRef.current, buyer: data.me };
          detailsRef.current = next;
          setDetails(next);
          try { localStorage.setItem(detailsKey, JSON.stringify(next)); } catch { setDetailsError(ar ? "تعذر حفظ تفاصيل القائمة على هذا الجهاز." : "List details could not be saved on this device."); }
        }
      })
      .catch(() => { if (alive) setContextError(true); });
    return () => { alive = false; controller.abort(); };
  }, [ready, detailsKey, contextAttempt, ar]);

  function saveDetails(next: ListDetails) {
    detailsRef.current = next;
    setDetails(next);
    try { localStorage.setItem(detailsKey, JSON.stringify(next)); detailsRestoreFailed.current = false; setDetailsError(""); }
    catch { setDetailsError(tr("These list details could not be backed up. Keep the page open and retry.", "تعذر حفظ نسخة من تفاصيل القائمة. أبقِ الصفحة مفتوحة وأعد المحاولة.")); }
  }
  async function saveItems(next: MarketChecklistItem[]): Promise<boolean> {
    if (!ready || publish.locked) return false;
    try {
      validateMarketItems(next, true);
      localStorage.setItem(key, JSON.stringify({ version: 1, items: next }));
      itemsRef.current = next;
      setItems(next);
      setError("");
      setSaveMessage(tr("Saved on this device", "محفوظة على هذا الجهاز"));
      return true;
    } catch {
      setError(tr("The draft change was not saved. Your previous checklist is still available; retry before leaving.", "لم يُحفظ التغيير. ما زالت قائمتك السابقة محفوظة؛ أعد المحاولة قبل المغادرة."));
      return false;
    }
  }
  async function addItem(item: MarketChecklistItem) {
    const existing = itemsRef.current.find(row => row.id === item.id);
    if (existing) return JSON.stringify(existing) === JSON.stringify(item);
    return saveItems([...itemsRef.current, item]);
  }
  async function editItem(item: MarketChecklistItem) {
    if (!itemsRef.current.some(row => row.id === item.id)) return false;
    return saveItems(itemsRef.current.map(row => row.id === item.id ? marketEditItem(row, item) : row));
  }
  async function progress(payload: MarketProgressPayload) {
    if (!itemsRef.current.some(row => row.id === payload.item_id)) return false;
    return saveItems(itemsRef.current.map(row => row.id === payload.item_id ? { ...row, acquired_quantity: payload.acquired_quantity, unavailable: payload.unavailable, note: payload.note } : row));
  }
  const payload = { title: details.title.trim(), instructions: details.instructions, assigned_to: details.buyer, due_on: details.due, items };
  const unchangedPublished = published?.signature === JSON.stringify(payload);
  async function share(event: FormEvent) {
    event.preventDefault();
    if (!ready || publish.locked || !context?.planner || !itemsRef.current.length || detailsError || publicationError) return;
    if (unchangedPublished && published) { router.push(`/buying-lists/${published.listId}`); return; }
    await publish.send({ request_id: crypto.randomUUID(), list_id: crypto.randomUUID(), revision: 0, action: "create", payload: { ...payload, items: itemsRef.current } });
  }
  const newSuggestions = suggestions.filter(suggestion => !items.some(item => item.product_id && item.product_id === suggestion.product_id));
  async function importLegacy() {
    try {
      const incoming = marketItemsFromRecommendations(readRestockShoppingListStrict(), () => crypto.randomUUID());
      if (!incoming.length) { setSaveMessage(tr("No older saved product plan was found on this device.", "لم نعثر على خطة منتجات قديمة محفوظة على هذا الجهاز.")); return; }
      await saveItems(mergeMarketRecommendations(itemsRef.current, incoming));
    } catch { setError(tr("The older product plan could not be read safely. Add the needs manually or generate new suggestions.", "تعذر قراءة خطة المنتجات القديمة. أضف احتياجاتك يدوياً أو أنشئ اقتراحات جديدة.")); }
  }

  return <div className="space-y-5" dir={ar ? "rtl" : "ltr"}>
    <section className="surface-card space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">{tr("Your market checklist", "قائمتك للسوق")}</h2><p className="text-sm text-slate-600">{tr("Add what you need, accept another flavour when appropriate, and tick what you find. Save to Snacky to use the same list on your phone.", "أضف ما تحتاجه، واسمح بنكهات بديلة عند الحاجة، ثم علّم ما وجدته. احفظها في سناكي لاستخدام نفس القائمة على هاتفك.")}</p></div><div className="flex flex-wrap gap-2"><a className="btn-primary" href="#save-shopping-list">{tr("Save for phone", "الحفظ للهاتف")}</a><Link className="btn-secondary" href="/buying-lists">{tr("My saved lists", "قوائمي المحفوظة")}</Link></div></div>
      <p className="text-sm font-medium text-amber-800">{tr("Draft on this device", "مسودة على هذا الجهاز")}</p>
      {saveMessage ? <p role="status" className="text-sm text-emerald-800">{saveMessage}</p> : null}
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      {suggestionsWarning ? <p role="status" className={styles.notice}>{suggestionsWarning}</p> : null}
      {!ready && error ? <button type="button" className="btn-secondary" onClick={() => window.location.reload()}>{tr("Reload saved draft", "إعادة تحميل المسودة")}</button> : null}
      {published ? <p className={styles.notice}>{tr("A shared copy has been saved. Continue shopping there for progress on all your devices.", "حُفظت نسخة مشتركة. تابع التسوق فيها ليظهر تقدمك على جميع أجهزتك.")} <Link className="underline font-semibold" href={`/buying-lists/${published.listId}`}>{tr("Open saved checklist", "فتح القائمة المحفوظة")}</Link></p> : null}
    </section>
    {ready && newSuggestions.length > 0 ? <section className="surface-card space-y-2"><h2 className="font-semibold">{newSuggestions.length} {tr("new product suggestions", "اقتراحات منتجات جديدة")}</h2><p className="text-sm text-slate-600">{tr("Add these to your draft. Your existing names, quantities, manual additions and ticks will stay as you set them.", "أضفها إلى مسودتك. ستبقى الأسماء والكميات والإضافات اليدوية وعلامات الإنجاز الحالية كما حددتها.")}</p><button type="button" className="btn-secondary" disabled={publish.locked} onClick={() => { try { void saveItems(mergeMarketRecommendations(itemsRef.current, suggestions)); } catch { setError(tr("Too many items to add all suggestions. Keep this checklist within 200 needs.", "لا يمكن إضافة كل الاقتراحات. الحد الأقصى للقائمة 200 حاجة.")); } }}>{tr("Add new suggestions", "إضافة الاقتراحات الجديدة")}</button></section> : null}
    {ready ? <MarketChecklist items={items} ar={ar} draftKey={`${key}:input`} disabled={publish.locked} onAdd={addItem} onEdit={editItem} onProgress={progress} onRemove={itemId => saveItems(itemsRef.current.filter(item => item.id !== itemId))} /> : !error ? <p role="status">{tr("Opening your saved draft…", "جارٍ فتح المسودة المحفوظة…")}</p> : null}
    <section className="surface-card space-y-3" aria-labelledby="save-shopping-list">
      <h2 id="save-shopping-list" className="text-lg font-semibold">{tr("Save for your phone or another buyer", "الحفظ لهاتفك أو لمشترٍ آخر")}</h2>
      {publish.status}
      {publicationError ? <div className={styles.notice}><p>{tr("The reference to an earlier shared copy could not be read. Check My saved lists before creating another copy.", "تعذر قراءة مرجع نسخة مشتركة سابقة. راجع قوائمك المحفوظة قبل إنشاء نسخة أخرى.")}</p><Link href="/buying-lists" className="underline">{tr("Check saved lists", "مراجعة القوائم المحفوظة")}</Link><button type="button" className="btn-secondary mt-2" onClick={() => { if (window.confirm(tr("After checking your saved lists, start a new shared copy of this draft? Existing shared lists will stay as they are.", "بعد مراجعة القوائم المحفوظة، هل تريد بدء نسخة مشتركة جديدة من هذه المسودة؟ ستبقى القوائم السابقة كما هي."))) { try { localStorage.removeItem(publishedKey); setPublicationError(false); setPublished(null); } catch { /* Keep the warning until the reference is cleared. */ } } }}>{tr("Start a new shared copy", "بدء نسخة مشتركة جديدة")}</button></div> : null}
      {detailsError ? <p role="alert" className={styles.error}>{detailsError} <button type="button" className="underline" onClick={() => saveDetails(detailsRef.current)}>{tr("Retry backup", "إعادة الحفظ")}</button></p> : null}
      {contextError ? <p className={styles.notice}>{tr("Shared saving could not be loaded. Your draft is still available on this device.", "تعذر تحميل الحفظ المشترك. ما زالت مسودتك متاحة على هذا الجهاز.")} <button type="button" className="underline" onClick={() => setContextAttempt(attempt => attempt + 1)}>{tr("Retry", "إعادة المحاولة")}</button></p> : context && !context.planner ? <p>{tr("A purchasing planner can save and assign a shared checklist.", "يمكن لمسؤول الشراء حفظ قائمة مشتركة وإسنادها.")}</p> : <form onSubmit={share} className="space-y-3">
        <fieldset disabled={!ready || publish.locked || !context?.planner} className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm"><span>{tr("List title", "اسم القائمة")}</span><input className="w-full rounded-lg border p-3" value={details.title} required maxLength={160} onChange={event => saveDetails({ ...detailsRef.current, title: event.target.value })}/></label>
          <label className="space-y-1 text-sm"><span>{tr("Who is shopping?", "من سيقوم بالتسوق؟")}</span><select className="w-full rounded-lg border p-3" required value={details.buyer} onChange={event => saveDetails({ ...detailsRef.current, buyer: event.target.value })}><option value="">{tr("Choose buyer", "اختر المشتري")}</option>{context?.people.map(person => <option key={person.id} value={person.id}>{person.name}{person.id === context.me ? tr(" (me)", " (أنا)") : ""}</option>)}</select></label>
          <label className="space-y-1 text-sm"><span>{tr("Shopping date", "تاريخ التسوق")}</span><input className="w-full rounded-lg border p-3" type="date" required value={details.due} onChange={event => saveDetails({ ...detailsRef.current, due: event.target.value })}/></label>
          <label className="space-y-1 text-sm sm:col-span-2"><span>{tr("Instructions", "تعليمات")}</span><textarea className="w-full rounded-lg border p-3" rows={2} maxLength={3000} value={details.instructions} onChange={event => saveDetails({ ...detailsRef.current, instructions: event.target.value })}/></label>
        </fieldset>
        <button className="btn-primary" type="submit" disabled={!ready || publish.locked || !context?.planner || !items.length || Boolean(detailsError) || publicationError}>{publish.busy ? tr("Saving…", "جارٍ الحفظ…") : unchangedPublished ? tr("Open saved checklist", "فتح القائمة المحفوظة") : published ? tr("Save as a new shared checklist", "حفظ كقائمة مشتركة جديدة") : tr("Save to Snacky", "الحفظ في سناكي")}</button>
        {!items.length ? <p className="text-sm text-slate-600">{tr("Add at least one shopping need first.", "أضف حاجة واحدة على الأقل أولاً.")}</p> : null}
      </form>}
    </section>
    <section className="surface-card space-y-3"><h2 className="text-lg font-semibold">{tr("Receipt comes separately", "الإيصال خطوة منفصلة")}</h2><p className="text-sm text-slate-600">{tr("After shopping, record the exact products and flavours you bought, quantities, and prices. Ticking this checklist does not create a receipt or add stock.", "بعد التسوق، سجّل المنتجات والنكهات الفعلية والكميات والأسعار. وضع علامة في هذه القائمة لا ينشئ إيصالاً ولا يضيف مخزوناً.")}</p><div className="flex flex-wrap gap-3"><Link href="/purchases/new" className="btn-secondary">{tr("Record receipt", "تسجيل الإيصال")}</Link><Link href="/restock-priority/purchase-list" className="btn-secondary">{tr("View sales suggestions", "عرض اقتراحات المبيعات")}</Link></div></section>
    <details className="surface-card"><summary className="cursor-pointer text-sm font-medium">{tr("Use an older saved product plan", "استخدام خطة منتجات قديمة محفوظة")}</summary><p className="my-3 text-sm text-slate-600">{tr("Import the product plan saved in this browser. It adds new products without replacing this checklist.", "استورد خطة المنتجات المحفوظة في هذا المتصفح. ستضاف المنتجات الجديدة دون استبدال قائمتك الحالية.")}</p><button type="button" className="btn-secondary" disabled={!ready || publish.locked} onClick={() => void importLegacy()}>{tr("Import older plan", "استيراد الخطة القديمة")}</button></details>
  </div>;
}
