from pathlib import Path
import re


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    Path(path).write_text(text, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def regex_once(text: str, pattern: str, replacement: str, label: str) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one regex match, found {count}")
    return updated


# Route creation UI: add a stops-only planning mode and hide product work until storage.
path = "src/app/routes/new/RouteCreateForm.tsx"
text = read(path)
text = replace_once(text, 'type RouteCreateDraft = {\n  routeDate: string;\n  assignmentMode: "unassigned" | "assigned";', 'type RouteCreateDraft = {\n  routeDate: string;\n  creationMode: "full" | "stops_only";\n  assignmentMode: "unassigned" | "assigned";', "draft creation mode type")
text = replace_once(text, '  const [routeDate, setRouteDate] = useState(defaultRouteDate);\n  const [assignmentMode, setAssignmentMode] = useState<"unassigned" | "assigned">("unassigned");', '  const [routeDate, setRouteDate] = useState(defaultRouteDate);\n  const [creationMode, setCreationMode] = useState<"full" | "stops_only">("full");\n  const [assignmentMode, setAssignmentMode] = useState<"unassigned" | "assigned">("unassigned");', "creation mode state")
text = replace_once(text, '  const routeDraft = useMemo<RouteCreateDraft>(() => ({\n    routeDate,\n    assignmentMode,', '  const routeDraft = useMemo<RouteCreateDraft>(() => ({\n    routeDate,\n    creationMode,\n    assignmentMode,', "draft creation mode value")
text = replace_once(text, '    barcode,\n    expandedRecommendationGroups,', '    barcode,\n    creationMode,\n    expandedRecommendationGroups,', "draft dependency creation mode")
text = replace_once(text, '      draft.routeDate !== defaultRouteDate ||\n        draft.assignmentMode !== "unassigned" ||', '      draft.routeDate !== defaultRouteDate ||\n        draft.creationMode !== "full" ||\n        draft.assignmentMode !== "unassigned" ||', "draft save creation mode")
text = replace_once(text, '      setRouteDate(draft.routeDate || defaultRouteDate);\n      setAssignmentMode(draft.assignmentMode === "assigned" ? "assigned" : "unassigned");', '      setRouteDate(draft.routeDate || defaultRouteDate);\n      setCreationMode(draft.creationMode === "stops_only" ? "stops_only" : "full");\n      setAssignmentMode(draft.assignmentMode === "assigned" ? "assigned" : "unassigned");', "draft restore creation mode")
text = replace_once(text, '  const validate = () => {\n    if (!routeDate) return "Route date is required.";\n    if (assignmentMode === "assigned" && !operatorId) return "Choose a route performer or leave this route unassigned.";\n    if (!plannedRouteStock.length) {', '  const validate = () => {\n    if (!routeDate) return "Route date is required.";\n    if (assignmentMode === "assigned" && !operatorId) return "Choose a route performer or leave this route unassigned.";\n    if (creationMode === "stops_only") {\n      if (!machineIds.length) return "Choose at least one machine stop for the route plan.";\n      return "";\n    }\n    if (!plannedRouteStock.length) {', "stops-only validation")
text = replace_once(text, '        body: JSON.stringify({ routeDate, assignmentMode, operatorId: assignmentMode === "assigned" ? operatorId : "", machineIds, recommendationKeys, recommendationFinalTakeQty, manualStopItems, adminOverride }),', '        body: JSON.stringify({\n          routeDate,\n          creationMode,\n          assignmentMode,\n          operatorId: assignmentMode === "assigned" ? operatorId : "",\n          machineIds,\n          recommendationKeys: creationMode === "full" ? recommendationKeys : [],\n          recommendationFinalTakeQty: creationMode === "full" ? recommendationFinalTakeQty : [],\n          manualStopItems: creationMode === "full" ? manualStopItems : [],\n          adminOverride: creationMode === "full" ? adminOverride : false,\n        }),', "submit creation mode")
text = replace_once(text, '      window.sessionStorage.setItem("snacky-route-created", "Route created successfully.");', '      window.sessionStorage.setItem("snacky-route-created", creationMode === "stops_only" ? "Route stops planned. Add exact product quantities at storage before starting." : "Route created successfully.");', "creation success notice")
text = replace_once(text, '      </FormSection>\n\n      <FormSection title="Manual machine refill items">', '''      </FormSection>\n\n      <FormSection\n        title={tr(locale, "How do you want to create this route?", "كيف تريد إنشاء هذه الجولة؟")}\n        description={tr(locale, "Plan only the machine stops now, or build the complete product list immediately.", "خطط مواقع الأجهزة فقط الآن، أو أنشئ قائمة المنتجات الكاملة فورًا.")}\n      >\n        <div className="grid gap-3 md:grid-cols-2">\n          <label className={`rounded-2xl border p-4 text-sm transition ${creationMode === "stops_only" ? "border-[var(--snacky-primary)] bg-emerald-50 text-slate-950" : "border-slate-200 bg-white text-slate-700"}`}>\n            <input type="radio" name="creation_mode" value="stops_only" checked={creationMode === "stops_only"} onChange={() => setCreationMode("stops_only")} className="mr-2" disabled={saving} />\n            <span className="font-semibold">{tr(locale, "Plan machine stops only", "تخطيط مواقع الأجهزة فقط")}</span>\n            <span className="mt-1 block text-xs text-slate-500">{tr(locale, "Tell the operator which machines are planned. Add exact products and quantities later when you reach storage.", "أخبر المشغل بالأجهزة المخططة، ثم أضف المنتجات والكميات الدقيقة لاحقًا عند الوصول إلى المخزن.")}</span>\n          </label>\n          <label className={`rounded-2xl border p-4 text-sm transition ${creationMode === "full" ? "border-[var(--snacky-primary)] bg-emerald-50 text-slate-950" : "border-slate-200 bg-white text-slate-700"}`}>\n            <input type="radio" name="creation_mode" value="full" checked={creationMode === "full"} onChange={() => setCreationMode("full")} className="mr-2" disabled={saving} />\n            <span className="font-semibold">{tr(locale, "Build full route now", "إنشاء الجولة الكاملة الآن")}</span>\n            <span className="mt-1 block text-xs text-slate-500">{tr(locale, "Choose products and exact quantities before saving the route.", "اختر المنتجات والكميات الدقيقة قبل حفظ الجولة.")}</span>\n          </label>\n        </div>\n      </FormSection>\n\n      {creationMode === "stops_only" ? (\n        <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">\n          <div className="font-semibold">{tr(locale, "Products will be prepared at storage", "سيتم تجهيز المنتجات في المخزن")}</div>\n          <p className="mt-1 leading-6">{tr(locale, "The operator can see the assigned machine stops immediately. Snacky OS will keep Start Route locked until the exact product quantities are saved from the route page.", "يمكن للمشغل رؤية مواقع الأجهزة المسندة فورًا. سيبقي Snacky OS زر بدء الجولة مقفلاً حتى يتم حفظ كميات المنتجات الدقيقة من صفحة الجولة.")}</p>\n        </div>\n      ) : null}\n\n      <div className={creationMode === "stops_only" ? "hidden" : "contents"}>\n      <FormSection title="Manual machine refill items">''', "creation mode UI")
text = replace_once(text, '      </FormSection>\n\n      <FormSection title="Add machine stops manually">', '      </FormSection>\n      </div>\n\n      <FormSection title={creationMode === "stops_only" ? tr(locale, "Choose planned machine stops", "اختر مواقع الأجهزة المخططة") : tr(locale, "Add machine stops manually", "إضافة مواقع الأجهزة يدويًا")}>', "close full route sections")
text = replace_once(text, '        <p className="text-sm text-slate-500">{tr(locale, "Choose machines that should be included in the route even if there is no recommendation row.", "اختر الأجهزة التي يجب تضمينها في الجولة حتى لو لم توجد لها توصية.")}</p>', '        <p className="text-sm text-slate-500">{creationMode === "stops_only" ? tr(locale, "Select every machine the operator should visit. You can add the exact products later at storage.", "حدد كل جهاز يجب على المشغل زيارته. يمكنك إضافة المنتجات الدقيقة لاحقًا في المخزن.") : tr(locale, "Choose machines that should be included in the route even if there is no recommendation row.", "اختر الأجهزة التي يجب تضمينها في الجولة حتى لو لم توجد لها توصية.")}</p>', "machine stop description")
text = replace_once(text, '        {tr(locale, "Selected stops:", "المواقع المحددة:")} <span className="font-semibold text-slate-900">{selectedStopCount}</span>\n        <span className="mx-2 text-slate-300">/</span>\n        {tr(locale, "Route pick-list products:", "منتجات قائمة التحميل:")} <span className="font-semibold text-slate-900">{selectedProducts.length}</span>', '        {tr(locale, "Selected stops:", "المواقع المحددة:")} <span className="font-semibold text-slate-900">{selectedStopCount}</span>\n        <span className="mx-2 text-slate-300">/</span>\n        {creationMode === "stops_only" ? tr(locale, "Products: add at storage", "المنتجات: تضاف في المخزن") : <>{tr(locale, "Route pick-list products:", "منتجات قائمة التحميل:")} <span className="font-semibold text-slate-900">{selectedProducts.length}</span></>}', "route summary mode")
text = replace_once(text, '              {selectedProducts.length} items selected · {plannedRouteStock.reduce((sum, item) => sum + unitQuantity(item.quantity), 0)} total units', '              {creationMode === "stops_only" ? `${machineIds.length} machine stops planned · products added later at storage` : `${selectedProducts.length} items selected · ${plannedRouteStock.reduce((sum, item) => sum + unitQuantity(item.quantity), 0)} total units`}', "sticky summary mode")
text = replace_once(text, '          {saving ? tr(locale, "Creating route...", "جارٍ إنشاء الجولة...") : tr(locale, "Create route", "إنشاء جولة")}', '          {saving ? tr(locale, "Creating route...", "جارٍ إنشاء الجولة...") : creationMode === "stops_only" ? tr(locale, "Plan route stops", "تخطيط مواقع الجولة") : tr(locale, "Create route", "إنشاء جولة")}', "submit label mode")
write(path, text)


# Route API: create route + stops without product records, then use normal edit flow later.
path = "src/app/api/routes/route.ts"
text = read(path)
text = replace_once(text, 'type CreateRoutePayload = {\n  routeDate?: string;', 'type CreateRoutePayload = {\n  routeDate?: string;\n  creationMode?: "full" | "stops_only";', "API payload creation mode")
text = replace_once(text, '  const routeDate = String(payload.routeDate ?? "").trim();\n  const assignmentMode = payload.assignmentMode === "assigned" ? "assigned" : "unassigned";', '  const routeDate = String(payload.routeDate ?? "").trim();\n  const creationMode = payload.creationMode === "stops_only" ? "stops_only" : "full";\n  const stopsOnly = creationMode === "stops_only";\n  const assignmentMode = payload.assignmentMode === "assigned" ? "assigned" : "unassigned";', "API creation mode parsing")
text = replace_once(text, '  if (!recommendationKeys.length && !legacyRecommendationSlotIds.length && !manualStopItems.length) return jsonError("Choose machine-level refill items for this route.");', '  if (stopsOnly && !manualMachineIds.length) return jsonError("Choose at least one machine stop for this route plan.");\n  if (!stopsOnly && !recommendationKeys.length && !legacyRecommendationSlotIds.length && !manualStopItems.length) return jsonError("Choose machine-level refill items for this route.");', "API stop-only validation")
text = replace_once(text, '  const selectedMachineIds = Array.from(new Set([...manualMachineIds, ...recommendationMachineIds, ...manualStopItems.map((item) => item.machineId)]));', '  const selectedMachineIds = stopsOnly\n    ? manualMachineIds\n    : Array.from(new Set([...manualMachineIds, ...recommendationMachineIds, ...manualStopItems.map((item) => item.machineId)]));', "API selected stop machines")
text = replace_once(text, '  if (recommendationRows.length && !actionableRecommendationRows.length && !manualStopItems.length) {', '  if (!stopsOnly && recommendationRows.length && !actionableRecommendationRows.length && !manualStopItems.length) {', "API capacity validation mode")
text = replace_once(text, '  if (!stockByProduct.size) return jsonError("Planned machine refill quantities must be greater than zero.");', '  if (!stopsOnly && !stockByProduct.size) return jsonError("Planned machine refill quantities must be greater than zero.");', "API quantity requirement mode")
text = replace_once(text, '  if (!adminOverride) {\n    const stockValidation = await validateRouteStock(supabase, stockByProduct);', '  if (!stopsOnly && !adminOverride) {\n    const stockValidation = await validateRouteStock(supabase, stockByProduct);', "API stock validation mode")
text = regex_once(text, r'  const routeStockInsert = await supabase\.from\("route_stock_lines"\)\.insert\(.*?\n  \}\n\n  const verifyRoute =', '''  if (!stopsOnly) {\n    const routeStockInsert = await supabase.from("route_stock_lines").insert(\n      Array.from(stockByProduct.entries()).map(([productId, quantity]) => ({\n        route_id: routeId,\n        product_id: productId,\n        planned_qty: planQuantity(quantity),\n      })),\n    );\n\n    if (routeStockInsert.error) {\n      console.error("[routes:create] Failed to insert route stock lines", { routeId, error: routeStockInsert.error });\n      if (!adminOverride) {\n        const stockValidation = await validateRouteStock(supabase, stockByProduct, routeId);\n        if (stockValidation.error) console.error("[routes:create] Stock recheck after route stock insert failure failed", { routeId, error: stockValidation.error });\n        if (stockValidation.issues.length) {\n          await cleanupRoute();\n          return jsonError(stockValidationMessage(stockValidation.issues), 400, { code: "stock_exceeded", stockErrors: stockValidation.issues });\n        }\n      }\n      await cleanupRoute();\n      return jsonError("Could not save route stock. The route was not created.", 500);\n    }\n  }\n\n  const verifyRoute =''', "API route stock optional block")
text = replace_once(text, '       assignment_mode: assignmentMode,', '       assignment_mode: assignmentMode,\n       creation_mode: creationMode,\n       products_deferred_until_storage: stopsOnly,', "API activity creation mode")
text = replace_once(text, '  return NextResponse.json({ routeId });', '  return NextResponse.json({ routeId, productsDeferred: stopsOnly });', "API response creation mode")
write(path, text)


# Admin route detail: show a storage-preparation state and block starting until products exist.
path = "src/app/routes/[id]/page.tsx"
text = read(path)
text = replace_once(text, '  const canManageRouteAssignment = isAdminRole(profile);\n  const canEditRouteItems = isOwnerAdminRole(profile) && isRouteItemsEditableStatus(routeRow.status);\n  const hasPickMovements =', '  const canManageRouteAssignment = isAdminRole(profile);\n  const canEditRouteItems = isOwnerAdminRole(profile) && isRouteItemsEditableStatus(routeRow.status);\n  const routeProductsPrepared = Boolean((routeStock ?? []).some((item: any) => Number(item.planned_qty ?? 0) > 0) || routeStopItems.some((item: any) => Number(item.planned_quantity ?? 0) > 0));\n  const productsPendingAtStorage = routeStops.length > 0 && !routeProductsPrepared && isAvailableRouteStatus(routeRow.status);\n  const hasPickMovements =', "admin route preparation state")
text = replace_once(text, '  const canStartRoute = canExecuteRoutes(profile) && Boolean(profile.team_member_id) && isAvailableRouteStatus(routeRow.status);\n  const continueHref = canExecuteRoutes(profile)\n    ? nextOperatorRouteHref({ routeId: id, status: routeRow.status, hasPickup: hasPickMovements, stops: routeStops, start: true })\n    : null;', '  const canStartRoute = canExecuteRoutes(profile) && Boolean(profile.team_member_id) && isAvailableRouteStatus(routeRow.status) && routeProductsPrepared;\n  const continueHref = canExecuteRoutes(profile) && routeProductsPrepared\n    ? nextOperatorRouteHref({ routeId: id, status: routeRow.status, hasPickup: hasPickMovements, stops: routeStops, start: true })\n    : null;', "admin start lock")
text = replace_once(text, '{tr(locale, "Edit route items", "تعديل عناصر الجولة")}', '{productsPendingAtStorage ? tr(locale, "Prepare products at storage", "تجهيز المنتجات في المخزن") : tr(locale, "Edit route items", "تعديل عناصر الجولة")}', "admin edit button label")
text = replace_once(text, '        {success ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">{success}</div> : null}\n\n        <div className="grid gap-4 md:grid-cols-3">', '        {success ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">{success}</div> : null}\n        {productsPendingAtStorage ? (\n          <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">\n            <div className="font-semibold">{tr(locale, "Machine stops planned — products pending at storage", "تم تخطيط مواقع الأجهزة — المنتجات بانتظار التجهيز في المخزن")}</div>\n            <p className="mt-1 leading-6">{tr(locale, "The operator can already see the machines on this route. Add the exact product quantities when you reach storage; Start Route remains locked until then.", "يمكن للمشغل رؤية الأجهزة في هذه الجولة بالفعل. أضف كميات المنتجات الدقيقة عند الوصول إلى المخزن؛ وسيبقى بدء الجولة مقفلاً حتى ذلك الحين.")}</p>\n            {canEditRouteItems ? <Link href={`/routes/${id}/edit`} className="btn-primary mt-3 inline-flex">{tr(locale, "Prepare products now", "تجهيز المنتجات الآن")}</Link> : null}\n          </div>\n        ) : null}\n\n        <div className="grid gap-4 md:grid-cols-3">', "admin pending banner")
write(path, text)


# Operator route detail: show planned stops but no Start action until storage quantities are ready.
path = "src/app/operator/routes/[id]/page.tsx"
text = read(path)
text = replace_once(text, '  const pickItems = routeStockRows;\n  const hasPickup = pickItems.some((item) => Number(item.picked_qty ?? 0) > 0);', '  const pickItems = routeStockRows;\n  const routeProductsPrepared = pickItems.some((item) => Number(item.planned_qty ?? 0) > 0);\n  const hasPickup = pickItems.some((item) => Number(item.picked_qty ?? 0) > 0);', "operator prepared state")
text = replace_once(text, '  const continueHref = nextOperatorRouteHref({ routeId, status: routeRow.status, hasPickup, stops: routeStops, start: true });', '  const continueHref = routeProductsPrepared\n    ? nextOperatorRouteHref({ routeId, status: routeRow.status, hasPickup, stops: routeStops, start: true })\n    : null;', "operator continue lock")
text = replace_once(text, '        {translatedError ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{translatedError}</div> : null}\n        {operatorError || machinesError || adjustmentsError ? (', '        {translatedError ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">{translatedError}</div> : null}\n        {!routeProductsPrepared && totalStops > 0 ? (\n          <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">\n            <div className="font-semibold">{t("Machine stops assigned — waiting for storage quantities")}</div>\n            <p className="mt-1 leading-6">{t("You can review every machine on this route now. The exact products and quantities will be added at storage before the route can start.")}</p>\n          </div>\n        ) : null}\n        {operatorError || machinesError || adjustmentsError ? (', "operator pending banner")
text = replace_once(text, '                <div className="text-sm text-slate-600">{t("Route completed")}</div>', '                <div className="text-sm text-slate-600">{routeProductsPrepared ? t("Route completed") : t("Waiting for product quantities")}</div>', "operator action fallback")
write(path, text)


# Server guard: direct URLs cannot start a stop-only route before preparation.
path = "src/lib/operator-actions.ts"
text = read(path)
text = replace_once(text, '  if (isActiveRouteStatus(route.status)) {\n    return { success: true };\n  }\n\n  const now = new Date().toISOString();', '  if (isActiveRouteStatus(route.status)) {\n    return { success: true };\n  }\n\n  const preparedStockResult = await supabase\n    .from("route_stock_lines")\n    .select("planned_qty")\n    .eq("route_id", routeId);\n  if (preparedStockResult.error) throwActionError(preparedStockResult.error, "Could not verify the route product plan.");\n  const hasPreparedProducts = (preparedStockResult.data ?? []).some((row: any) => unitQuantity(row.planned_qty) > 0);\n  if (!hasPreparedProducts) {\n    throw new Error("Route products have not been prepared yet. Add exact quantities at storage before starting.");\n  }\n\n  const now = new Date().toISOString();', "server start guard")
write(path, text)


# Route item editor: make empty planned routes explicitly a storage-preparation workflow.
path = "src/app/routes/[id]/edit/page.tsx"
text = read(path)
text = replace_once(text, '  const warningMessage = isPickupConfirmedStatus(route.status)', '  const preparationMode = initialRows.every((row) => Number(row.quantity ?? 0) <= 0);\n\n  const warningMessage = isPickupConfirmedStatus(route.status)', "edit preparation state")
text = replace_once(text, '        title={locale === "ar" ? "تعديل عناصر الجولة" : "Edit route items"}\n        subtitle={locale === "ar" ? "حدّث عناصر الجولة والكميات من دون إنشاء حركات مخزون تلقائيًا." : "Update route items and quantities without creating inventory movements automatically."}', '        title={preparationMode ? (locale === "ar" ? "تجهيز منتجات الجولة في المخزن" : "Prepare route products at storage") : (locale === "ar" ? "تعديل عناصر الجولة" : "Edit route items")}\n        subtitle={preparationMode ? (locale === "ar" ? "أضف المنتجات والكميات الدقيقة الآن. سيبني Snacky OS قائمة التحميل من دون تحريك المخزون حتى تأكيد التحميل." : "Add the exact products and quantities now. Snacky OS builds the pick list without moving inventory until pickup is confirmed.") : (locale === "ar" ? "حدّث عناصر الجولة والكميات من دون إنشاء حركات مخزون تلقائيًا." : "Update route items and quantities without creating inventory movements automatically.")}', "edit page preparation title")
text = replace_once(text, '        warningMessage={warningMessage}\n      />', '        warningMessage={warningMessage}\n        preparationMode={preparationMode}\n      />', "editor preparation prop")
write(path, text)

path = "src/app/routes/[id]/edit/RouteItemEditor.tsx"
text = read(path)
text = replace_once(text, '  warningMessage?: string | null;\n};', '  warningMessage?: string | null;\n  preparationMode?: boolean;\n};', "editor prop type")
text = replace_once(text, '  initialRows,\n  warningMessage,\n}: RouteItemEditorProps) {', '  initialRows,\n  warningMessage,\n  preparationMode = false,\n}: RouteItemEditorProps) {', "editor prop destructure")
text = replace_once(text, '      {warningMessage ? (', '      {preparationMode ? (\n        <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">\n          <div className="font-semibold">{tr(locale, "Add exact quantities at storage", "أضف الكميات الدقيقة في المخزن")}</div>\n          <p className="mt-1 leading-6">{tr(locale, "The machine stops are already assigned to the operator. Add at least one product to each stop that needs stock, then save to build the route pick list.", "تم إسناد مواقع الأجهزة للمشغل بالفعل. أضف منتجًا واحدًا على الأقل لكل موقع يحتاج مخزونًا، ثم احفظ لبناء قائمة تحميل الجولة.")}</p>\n        </div>\n      ) : null}\n      {warningMessage ? (', "editor preparation notice")
text = replace_once(text, '{tr(locale, "Save route changes", "حفظ تعديلات الجولة")}', '{preparationMode ? tr(locale, "Save products and build pick list", "حفظ المنتجات وبناء قائمة التحميل") : tr(locale, "Save route changes", "حفظ تعديلات الجولة")}', "editor save label")
write(path, text)


# Static regression coverage in the existing critical workflow suite.
path = "scripts/test-critical-workflows.mjs"
text = read(path)
append = r'''

test("route stops can be planned before products and starting stays locked", () => {
  const routeForm = readFileSync("src/app/routes/new/RouteCreateForm.tsx", "utf8");
  const routeApi = readFileSync("src/app/api/routes/route.ts", "utf8");
  const adminRoute = readFileSync("src/app/routes/[id]/page.tsx", "utf8");
  const operatorRoute = readFileSync("src/app/operator/routes/[id]/page.tsx", "utf8");
  const operatorActions = readFileSync("src/lib/operator-actions.ts", "utf8");
  const editPage = readFileSync("src/app/routes/[id]/edit/page.tsx", "utf8");
  const editor = readFileSync("src/app/routes/[id]/edit/RouteItemEditor.tsx", "utf8");

  assert.match(routeForm, /creationMode: "full" \| "stops_only"/);
  assert.match(routeForm, /Plan machine stops only/);
  assert.match(routeForm, /products added later at storage/);
  assert.match(routeApi, /stopsOnly && !manualMachineIds\.length/);
  assert.match(routeApi, /productsDeferred: stopsOnly/);
  assert.match(routeApi, /if \(!stopsOnly\) \{[\s\S]*route_stock_lines/);
  assert.match(adminRoute, /Prepare products at storage/);
  assert.match(operatorRoute, /waiting for storage quantities/i);
  assert.match(operatorRoute, /routeProductsPrepared/);
  assert.match(operatorActions, /Route products have not been prepared yet/);
  assert.match(editPage, /Prepare route products at storage/);
  assert.match(editor, /Save products and build pick list/);
});
'''
if 'test("route stops can be planned before products and starting stays locked"' in text:
    raise RuntimeError("critical workflow regression already exists")
text = text.rstrip() + append
write(path, text)

print("Applied stop-only route planning workflow.")
