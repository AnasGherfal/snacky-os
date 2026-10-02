import { LocalDraftForm } from "@/components/LocalDraft";
import { PrimaryButton, SecondaryButton, FormField, FormSection } from "@/components/ui";
import {
  StorageLocationRow,
  storageLocationHelperBody,
  storageLocationHelperTitle,
  storageLocationTypeHelperCards,
  storageLocationTypeLabel,
  storageLocationTypes,
} from "@/lib/storage-locations";

type OperatorOption = {
  id: string;
  full_name: string;
  email: string | null;
  role: string;
};

export function StorageLocationForm({
  action,
  location,
  operators,
  submitLabel,
  locale,
}: {
  action: (formData: FormData) => void | Promise<void>;
  location?: StorageLocationRow | null;
  operators: OperatorOption[];
  submitLabel: string;
  locale: "en" | "ar";
}) {
  const t = (en: string, ar: string) => (locale === "ar" ? ar : en);

  return (
    <LocalDraftForm action={action} formType="storage-location" draftKeyParts={[location?.id ?? "new"]} className="space-y-5">
      {location?.id ? <input type="hidden" name="id" value={location.id} /> : null}

      <FormSection title={t("Location Details", "تفاصيل الموقع")} description={t("Name the physical or operational stock location and link an operator only when this is an operator bag.", "سمِّ موقع المخزون المادي أو التشغيلي، واربط مشغلاً فقط عندما يكون الموقع حقيبة مشغل.")}>
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label={t("Location name", "اسم الموقع")} required hint={t("Use a clear operational name like MAIN, Operator Bag - Ahmed, or Temporary Stock Count.", "استخدم اسمًا تشغيليًا واضحًا مثل MAIN أو حقيبة المشغل - أحمد أو جرد مخزون مؤقت.")}>
            <input name="name" required defaultValue={location?.name ?? ""} className="field-input" placeholder={t("MAIN", "الرئيسي")} />
          </FormField>

          <FormField label={t("Type", "النوع")} required>
            <select name="location_type" required defaultValue={location?.location_type ?? "main_storage"} className="field-input">
              {storageLocationTypes.map((type) => (
                <option key={type} value={type}>
                  {storageLocationTypeLabel(type, locale)}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label={t("Related operator", "المشغل المرتبط")} hint={t("Required for operator bag locations. Leave empty for warehouses and internal locations.", "مطلوب لمواقع حقيبة المشغل. اتركه فارغًا للمخازن والمواقع الداخلية.")}>
            <select name="related_operator_id" defaultValue={location?.related_operator_id ?? ""} className="field-input">
              <option value="">{t("No related operator", "لا يوجد مشغل مرتبط")}</option>
              {operators.map((operator) => (
                <option key={operator.id} value={operator.id}>
                  {operator.full_name}{operator.email ? ` (${operator.email})` : ""}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label={t("Status", "الحالة")} hint={t("Use the archive/deactivate control on the detail page to change availability.", "استخدم خيار الأرشفة/التعطيل في صفحة التفاصيل لتغيير الإتاحة.")}>
            <input type="hidden" name="active" value={String(location?.active ?? true)} />
            <input value={(location?.active ?? true) ? (locale === "ar" ? "نشط" : "Active") : (locale === "ar" ? "مؤرشف" : "Archived")} readOnly className="field-input bg-slate-50" />
          </FormField>

          <FormField label={t("Latitude", "خط العرض")} hint={t("Optional for future distance calculation from storage to route stops.", "اختياري لحساب المسافة مستقبلاً من المخزن إلى مواقع الجولة.")}>
            <input name="latitude" type="number" step="0.00000001" defaultValue={location?.latitude ?? ""} className="field-input" placeholder="32.8872" />
          </FormField>

          <FormField label={t("Longitude", "خط الطول")} hint={t("Optional for future route distance APIs and manual map checks.", "اختياري لواجهات حساب مسافة الجولة وفحص الخريطة اليدوي.")}>
            <input name="longitude" type="number" step="0.00000001" defaultValue={location?.longitude ?? ""} className="field-input" placeholder="13.1913" />
          </FormField>

          <div className="md:col-span-2">
            <FormField label={t("Address or notes", "العنوان / الملاحظات")} hint={t("Optional physical address, shelf label, vehicle plate, or operational note.", "عنوان مادي اختياري، أو رقم رف، أو لوحة مركبة، أو ملاحظة تشغيلية.")}>
              <textarea name="address" rows={4} defaultValue={location?.address ?? ""} className="field-input" placeholder={t("Warehouse address, shelf note, or route bag description", "عنوان المخزن أو ملاحظة الرف أو وصف حقيبة الجولة")} />
            </FormField>
          </div>
        </div>
      </FormSection>

      <section className="grid gap-3 md:grid-cols-3">
        {storageLocationTypeHelperCards.map((helper) => (
          <div key={helper.title.en} className="surface-card rounded-lg p-4">
            <h3 className="text-sm font-semibold text-slate-900">{storageLocationHelperTitle(helper.title.en, locale)}</h3>
            <p className="mt-1 text-sm text-slate-500">{storageLocationHelperBody(helper.title.en, helper.body.en, locale)}</p>
          </div>
        ))}
      </section>

      <div className="flex flex-col gap-3 sm:flex-row">
        <PrimaryButton>{submitLabel}</PrimaryButton>
        <SecondaryButton href={location?.id ? `/storage-locations/${location.id}` : "/storage-locations"}>{t("Cancel", "إلغاء")}</SecondaryButton>
      </div>
    </LocalDraftForm>
  );
}
