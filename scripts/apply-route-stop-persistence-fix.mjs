import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quickActionsPath = path.join(root, "src/components/operator/RouteStopQuickActions.tsx");
const stopPagePath = path.join(root, "src/app/operator/routes/[id]/stops/[stopId]/page.tsx");
const completionPhotoPath = path.join(root, "src/app/api/operator/routes/[id]/stops/[stopId]/completion-photo/route.ts");
const instructionsPanelPath = path.join(root, "src/components/operator/OperatorInstructionsPanel.tsx");
const routesPagePath = path.join(root, "src/app/operator/routes/page.tsx");

function patchFile(filePath, patches) {
  let source = fs.readFileSync(filePath, "utf8");
  for (const patch of patches) {
    if (source.includes(patch.marker)) continue;
    const first = source.indexOf(patch.oldText);
    const second = first < 0 ? -1 : source.indexOf(patch.oldText, first + patch.oldText.length);
    if (first < 0 || second >= 0) {
      throw new Error(`Could not safely apply ${patch.label}: expected exactly one source match in ${path.relative(root, filePath)}.`);
    }
    source = source.slice(0, first) + patch.newText + source.slice(first + patch.oldText.length);
  }
  fs.writeFileSync(filePath, source);
}

patchFile(completionPhotoPath, [
  {
    label: "completion-photo privileged read",
    marker: "// Persisted completion proof must be read with the same server client used to write it.",
    oldText: `  const { data, error } = await context.client\n    .from("machine_refill_history")\n    .select("machine_photo_url, machine_photo_path, updated_at")\n    .eq("legacy_refill_id", \`route_stop:\${stopId}\`)\n    .maybeSingle();`,
    newText: `  // Persisted completion proof must be read with the same server client used to write it.\n  // Operators can have narrower RLS access than the server-side persistence path.\n  const { data, error } = await context.writeClient\n    .from("machine_refill_history")\n    .select("machine_photo_url, machine_photo_path, updated_at")\n    .eq("legacy_refill_id", \`route_stop:\${stopId}\`)\n    .maybeSingle();`,
  },
]);

patchFile(quickActionsPath, [
  {
    label: "broadcast loaded machine photo state",
    marker: "snacky:machine-photo-persisted-loaded",
    oldText: `        setMachineId(String(payload.machineId ?? ""));\n        setPhotoSaved(Boolean(payload.saved));\n        setPhotoSavedAt(payload.savedAt ?? null);`,
    newText: `        setMachineId(String(payload.machineId ?? ""));\n        const persistedSaved = Boolean(payload.saved);\n        setPhotoSaved(persistedSaved);\n        setPhotoSavedAt(payload.savedAt ?? null);\n        // snacky:machine-photo-persisted-loaded\n        window.dispatchEvent(new CustomEvent("snacky:machine-photo-persisted", { detail: { saved: persistedSaved } }));`,
  },
  {
    label: "broadcast newly saved machine photo state",
    marker: "snacky:machine-photo-persisted-saved",
    oldText: `      setPhotoSaved(true);\n      setPhotoSavedAt(payload?.savedAt ?? new Date().toISOString());\n      setPhotoFile(null);`,
    newText: `      setPhotoSaved(true);\n      setPhotoSavedAt(payload?.savedAt ?? new Date().toISOString());\n      setPhotoFile(null);\n      // snacky:machine-photo-persisted-saved\n      window.dispatchEvent(new CustomEvent("snacky:machine-photo-persisted", { detail: { saved: true } }));`,
  },
]);

patchFile(stopPagePath, [
  {
    label: "persisted machine photo state listener",
    marker: "const [persistedMachinePhotoReady, setPersistedMachinePhotoReady]",
    oldText: `  const [compressorSafetyInstalled, setCompressorSafetyInstalled] = useState(false);\n  const [compressorProofReady, setCompressorProofReady] = useState(false);`,
    newText: `  const [compressorSafetyInstalled, setCompressorSafetyInstalled] = useState(false);\n  const [compressorProofReady, setCompressorProofReady] = useState(false);\n  const [persistedMachinePhotoReady, setPersistedMachinePhotoReady] = useState(false);\n\n  useEffect(() => {\n    const handlePersistedMachinePhoto = (event: Event) => {\n      const detail = (event as CustomEvent<{ saved?: boolean }>).detail;\n      setPersistedMachinePhotoReady(Boolean(detail?.saved));\n    };\n    window.addEventListener("snacky:machine-photo-persisted", handlePersistedMachinePhoto);\n    return () => window.removeEventListener("snacky:machine-photo-persisted", handlePersistedMachinePhoto);\n  }, []);`,
  },
  {
    label: "stop execution summary persisted proof",
    marker: "proofReady: Boolean(finalPhotoFile || persistedMachinePhotoReady || stopData.hasCompletionPhoto)",
    oldText: `      proofReady: Boolean(finalPhotoFile || stopData.hasCompletionPhoto),`,
    newText: `      proofReady: Boolean(finalPhotoFile || persistedMachinePhotoReady || stopData.hasCompletionPhoto),`,
  },
  {
    label: "stop execution summary dependency",
    marker: "finalPhotoFile, persistedMachinePhotoReady, missingReports",
    oldText: `  }, [extraProducts, filledQtys, finalPhotoFile, missingReports, stopData, unavailableProducts]);`,
    newText: `  }, [extraProducts, filledQtys, finalPhotoFile, persistedMachinePhotoReady, missingReports, stopData, unavailableProducts]);`,
  },
  {
    label: "completion accepts separately persisted photo",
    marker: "const hasPersistedMachineProof = persistedMachinePhotoReady || Boolean(stopData.hasCompletionPhoto);",
    oldText: `    const canReuseCompletedProof = stopData.stopStatus === ROUTE_STOP_COMPLETED_STATUS && stopData.hasCompletionPhoto;`,
    newText: `    const hasPersistedMachineProof = persistedMachinePhotoReady || Boolean(stopData.hasCompletionPhoto);\n    const canReuseCompletedProof = hasPersistedMachineProof;`,
  },
  {
    label: "saved photo helper copy",
    marker: "!finalPhotoFile && (persistedMachinePhotoReady || stopData.hasCompletionPhoto)",
    oldText: `              {!finalPhotoFile && stopData.hasCompletionPhoto ? <p className="mt-2 text-sm text-slate-600">`,
    newText: `              {!finalPhotoFile && (persistedMachinePhotoReady || stopData.hasCompletionPhoto) ? <p className="mt-2 text-sm text-slate-600">`,
  },
  {
    label: "required photo helper copy",
    marker: "!finalPhotoFile && !persistedMachinePhotoReady && !stopData.hasCompletionPhoto",
    oldText: `              {!finalPhotoFile && !stopData.hasCompletionPhoto ? <p className="mt-2 text-sm text-amber-700">`,
    newText: `              {!finalPhotoFile && !persistedMachinePhotoReady && !stopData.hasCompletionPhoto ? <p className="mt-2 text-sm text-amber-700">`,
  },
  {
    label: "photo ready description persisted proof",
    marker: "persistedMachinePhotoReady || stopData.hasCompletionPhoto ? tr(\"Existing proof photo is already attached.\"",
    oldText: `                {finalPhotoFile ? tr("New proof photo will upload with this save.", "سيتم رفع صورة إثبات جديدة مع هذا الحفظ.") : stopData.hasCompletionPhoto ? tr("Existing proof photo is already attached.", "صورة الإثبات الحالية مرفقة بالفعل.") : tr("Take a completion photo before finishing this stop.", "التقط صورة إنهاء قبل إتمام هذا الموقع.")}`,
    newText: `                {finalPhotoFile ? tr("New proof photo will upload with this save.", "سيتم رفع صورة إثبات جديدة مع هذا الحفظ.") : persistedMachinePhotoReady || stopData.hasCompletionPhoto ? tr("Existing proof photo is already attached.", "صورة الإثبات الحالية مرفقة بالفعل.") : tr("Take a completion photo before finishing this stop.", "التقط صورة إنهاء قبل إتمام هذا الموقع.")}`,
  },
]);

patchFile(instructionsPanelPath, [
  {
    label: "instructions hide-setup-warning prop",
    marker: "hideSetupWarning?: boolean;",
    oldText: `type Props = {\n  initialOperatorId?: string;\n  lockOperator?: boolean;\n  className?: string;\n};`,
    newText: `type Props = {\n  initialOperatorId?: string;\n  lockOperator?: boolean;\n  className?: string;\n  hideSetupWarning?: boolean;\n};`,
  },
  {
    label: "instructions hide-setup-warning destructure",
    marker: "hideSetupWarning = false,",
    oldText: `  initialOperatorId = "",\n  lockOperator = false,\n  className = "",\n}: Props) {`,
    newText: `  initialOperatorId = "",\n  lockOperator = false,\n  className = "",\n  hideSetupWarning = false,\n}: Props) {`,
  },
  {
    label: "instructions setup warning suppressed on operator routes",
    marker: "if (!snapshot && setupRequired && hideSetupWarning) return null;",
    oldText: `  if (!snapshot) {\n    return (`,
    newText: `  if (!snapshot && setupRequired && hideSetupWarning) return null;\n\n  if (!snapshot) {\n    return (`,
  },
]);

patchFile(routesPagePath, [
  {
    label: "operator routes suppress database setup card",
    marker: "<OperatorInstructionsPanel hideSetupWarning />",
    oldText: `        <OperatorInstructionsPanel />`,
    newText: `        <OperatorInstructionsPanel hideSetupWarning />`,
  },
]);

console.log("Applied route-stop persistence and operator-routes setup-warning fix.");
