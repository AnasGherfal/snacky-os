const fs = require('node:fs');

function patch(path, replacements) {
  let source = fs.readFileSync(path, 'utf8');
  for (const [from, to] of replacements) {
    if (!source.includes(from)) throw new Error(`Expected source block not found in ${path}: ${from.slice(0, 120)}`);
    source = source.replace(from, to);
  }
  fs.writeFileSync(path, source);
}

patch('src/app/operator/routes/[id]/pick-list/page.tsx', [
  [
    '  const shouldStartRoute = searchParams.get("start") === "1";\n',
    '  const shouldStartRoute = searchParams.get("start") === "1";\n  const requestedStopId = searchParams.get("stop")?.trim() ?? "";\n',
  ],
  [
    '            chooseExtraDestination: "كل منتج إضافي يجب ربطه بمحطة / ماكينة حتى يُضاف فعليًا للجولة.",\n',
    '            chooseExtraDestination: "كل منتج إضافي يجب ربطه بمحطة / ماكينة حتى يُضاف فعليًا للجولة.",\n            checkAll: "علّم كل منتجات الاستلام المحددة قبل تأكيد الاستلام.",\n',
  ],
  [
    '            directNote: "علامات الصح للتتبع فقط ولا تمنع التأكيد. المنتجات الإضافية تُحفظ فعليًا على المحطة وتظهر للإدارة في ملخص الجولة بعد التأكيد.",\n',
    '            directNote: "يجب وضع علامة الصح على كل منتج محدد قبل تأكيد الاستلام. المنتجات الإضافية تُحفظ فعليًا على المحطة وتظهر للإدارة في ملخص الجولة بعد التأكيد.",\n',
  ],
  [
    '            chooseExtraDestination: "Every extra product must be assigned to a stop / machine so it becomes part of the route.",\n',
    '            chooseExtraDestination: "Every extra product must be assigned to a stop / machine so it becomes part of the route.",\n            checkAll: "Check every selected pickup item before confirming pickup.",\n',
  ],
  [
    '            directNote: "Checks are only a progress aid and never block confirmation. Extra products are saved to the selected stop and appear in the admin route summary after confirmation.",\n',
    '            directNote: "Every selected pickup item must be checked before confirmation. Extra products are saved to the selected stop and appear in the admin route summary after confirmation.",\n',
  ],
  [
    '  const pickedProgressCount = useMemo(\n    () => selectedPickupItemIds.filter((id) => checkedPickupItemIds.includes(id)).length,\n    [selectedPickupItemIds, checkedPickupItemIds],\n  );\n',
    '  const checkedPickupItemSet = useMemo(() => new Set(checkedPickupItemIds), [checkedPickupItemIds]);\n  const pickedProgressCount = useMemo(\n    () => selectedPickupItemIds.filter((id) => checkedPickupItemSet.has(id)).length,\n    [selectedPickupItemIds, checkedPickupItemSet],\n  );\n  const allSelectedPickupItemsChecked = useMemo(\n    () => selectedPickupItemIds.length > 0 && selectedPickupItemIds.every((id) => checkedPickupItemSet.has(id)),\n    [selectedPickupItemIds, checkedPickupItemSet],\n  );\n',
  ],
  [
    '      setStopGroups(groups);\n      setSelectedStopIds(groups.map((group) => group.routeStopId));\n',
    '      setStopGroups(groups);\n      const requestedGroup = requestedStopId ? groups.find((group) => group.routeStopId === requestedStopId) : null;\n      setSelectedStopIds(requestedGroup ? [requestedGroup.routeStopId] : groups.map((group) => group.routeStopId));\n',
  ],
  [
    '  }, [copy.startFailed, isArabic, routeId, shouldStartRoute]);',
    '  }, [copy.startFailed, isArabic, requestedStopId, routeId, shouldStartRoute]);',
  ],
  [
    '    if (!selectedStopIds.length) {\n      setError(copy.chooseStop);\n      return;\n    }\n    if (extras.some((item) => item.quantity > 0 && !item.productId)) {\n',
    '    if (!selectedStopIds.length) {\n      setError(copy.chooseStop);\n      return;\n    }\n    if (!allSelectedPickupItemsChecked) {\n      setError(copy.checkAll);\n      return;\n    }\n    if (extras.some((item) => item.quantity > 0 && !item.productId)) {\n',
  ],
  [
    '      const result = await confirmPickupDirect(routeId, pickedItems, extraPayload, {\n        stopIds: [...selectedStopIds],\n        clientSubmissionId: submissionIdRef.current,\n      });\n',
    '      const result = await confirmPickupDirect(routeId, pickedItems, extraPayload, {\n        stopIds: [...selectedStopIds],\n        clientSubmissionId: submissionIdRef.current,\n        acknowledgedPickupLineIds: selectedPickupItemIds.filter((id) => checkedPickupItemSet.has(id)),\n      });\n',
  ],
  [
    '          <button type="button" className="min-h-12 w-full rounded-xl bg-emerald-600 px-6 py-3 text-base font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-300 sm:w-auto" disabled={submitting || locked || confirmed || !selectedStopIds.length || !stopGroups.length} onClick={() => void handleConfirm()}>{submitting ? copy.confirming : copy.confirm}</button>',
    '          <button type="button" className="min-h-12 w-full rounded-xl bg-emerald-600 px-6 py-3 text-base font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-300 sm:w-auto" disabled={submitting || locked || confirmed || !selectedStopIds.length || !stopGroups.length || !allSelectedPickupItemsChecked} onClick={() => void handleConfirm()}>{submitting ? copy.confirming : copy.confirm}</button>',
  ],
]);

patch('src/app/operator/routes/[id]/page.tsx', [
  [
    '<Link href={`/operator/routes/${routeId}/pick-list`} className="btn-primary w-full text-base sm:w-auto">\n                          {t("Pick this stop")}\n                        </Link>',
    '<Link href={`/operator/routes/${routeId}/pick-list?stop=${stop.id}`} className="btn-primary w-full text-base sm:w-auto">\n                          {t("Pick this stop")}\n                        </Link>',
  ],
]);
