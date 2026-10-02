import {
  batchImportedRows,
  batchLastUpdatedAt,
  isActiveImportedVmsBatch,
  sourceFileName,
  type VmsDashboardBatch,
} from "./vms-dashboard-source.ts";

export type VmsImportBatchLike = VmsDashboardBatch & {
  delete_reason?: string | null;
  deleted_by?: string | null;
  disabled_at?: string | null;
  disabled_by?: string | null;
  disable_reason?: string | null;
  file_hash?: string | null;
  imported_by?: string | null;
  original_file_name?: string | null;
  row_count?: number | null;
  rows_found?: number | null;
  rows_imported?: number | null;
  rows_needing_review?: number | null;
  source_type?: string | null;
  uploaded_by?: string | null;
};

export type VmsImportBatchDuplicateContext = {
  sameFileHashActiveCount?: number;
  sameFileHashDeletedCount?: number;
  sameFileHashGroupSize?: number;
  sameFileHashInactiveCount?: number;
  sameFileHashLeaderId?: string | null;
  sameFileHashRepresentativeFileName?: string | null;
  sameFileHashRepresentativeId?: string | null;
};

export type VmsImportBatchStatus = {
  action: "finalize" | "reprocess" | "restore" | "review_mappings" | "view_existing" | "none";
  actionLabel: string | null;
  activeInDashboard: boolean;
  key: string;
  label: string;
  relatedBatchId: string | null;
  reason: string;
  secondaryAction: "import_as_new_active" | "reprocess" | "restore" | "review_mappings" | "none";
  secondaryActionLabel: string | null;
};

const supportedReportTypes = new Set([
  'vms_order_details_weekly',
  'monthly_transaction_details',
  'monthly_product_profit',
  'sales',
  'stock',
  'machine_stock_snapshot',
  'planogram',
  'product_list',
  'machine_status',
]);

const knownImportStatuses = new Set([
  'uploaded',
  'parsed',
  'imported',
  'imported_active',
  'imported_inactive',
  'failed',
  'deleted',
  'duplicate_active',
  'duplicate_deleted',
  'needs_reprocess',
  'needs_mapping_but_imported',
  'unsupported_file',
  'previewed',
  'draft',
  'cancelled',
  'canceled',
  'disabled',
]);

function textValue(value: unknown) {
  return String(value ?? "").trim();
}

function normalizedStatus(batch: Pick<VmsImportBatchLike, "status">) {
  return textValue(batch.status).toLowerCase();
}

function reportTypeValue(batch: Pick<VmsImportBatchLike, "report_type" | "source_type">) {
  return textValue(batch.report_type ?? batch.source_type);
}

function isSupportedImportReportType(reportType: string) {
  return supportedReportTypes.has(reportType);
}

function batchSortValue(batch: VmsImportBatchLike) {
  return batchLastUpdatedAt(batch) ?? sourceFileName(batch) ?? "";
}

function compareDuplicateRepresentative(left: VmsImportBatchLike, right: VmsImportBatchLike) {
  const leftActive = isActiveImportedVmsBatch(left);
  const rightActive = isActiveImportedVmsBatch(right);
  if (leftActive !== rightActive) return leftActive ? -1 : 1;

  const leftDeleted = Boolean(left.deleted_at);
  const rightDeleted = Boolean(right.deleted_at);
  if (leftDeleted !== rightDeleted) return leftDeleted ? 1 : -1;

  const sorted = batchSortValue(right).localeCompare(batchSortValue(left));
  if (sorted !== 0) return sorted;

  return sourceFileName(left).localeCompare(sourceFileName(right));
}

export function vmsImportReportTypeLabel(reportType: string | null | undefined) {
  switch (textValue(reportType)) {
    case "vms_order_details_weekly":
      return "Detailed Order Details";
    case "monthly_transaction_details":
      return "Monthly Transaction Report";
    case "monthly_product_profit":
      return "Monthly Profit Report";
    case "sales":
      return "VMS Sales Summary";
    case "stock":
    case "machine_stock_snapshot":
      return "Machine Stock Snapshot";
    case "planogram":
      return "Machine Planogram";
    case "product_list":
      return "Product Mapping";
    case "machine_status":
      return "Machine Status";
    default:
      return "Unsupported file";
  }
}

export function createVmsImportDuplicateContextMap(batches: VmsImportBatchLike[]) {
  const grouped = new Map<string, VmsImportBatchLike[]>();
  for (const batch of batches) {
    const fileHash = textValue(batch.file_hash);
    if (!fileHash) continue;
    const group = grouped.get(fileHash) ?? [];
    group.push(batch);
    grouped.set(fileHash, group);
  }

  const contexts = new Map<string, VmsImportBatchDuplicateContext>();
  for (const group of grouped.values()) {
    if (!group.length) continue;

    const representative = [...group].sort(compareDuplicateRepresentative)[0] ?? null;
    const activeCount = group.filter((batch) => isActiveImportedVmsBatch(batch)).length;
    const deletedCount = group.filter((batch) => Boolean(batch.deleted_at) || normalizedStatus(batch) === "deleted").length;
    const inactiveCount = Math.max(0, group.length - activeCount - deletedCount);
    const context: VmsImportBatchDuplicateContext = {
      sameFileHashActiveCount: activeCount,
      sameFileHashDeletedCount: deletedCount,
      sameFileHashGroupSize: group.length,
      sameFileHashInactiveCount: inactiveCount,
      sameFileHashLeaderId: representative?.id ?? null,
      sameFileHashRepresentativeFileName: representative ? sourceFileName(representative) : null,
      sameFileHashRepresentativeId: representative?.id ?? null,
    };

    for (const batch of group) {
      contexts.set(batch.id, context);
    }
  }

  return contexts;
}

export function describeVmsImportBatchStatus(
  batch: VmsImportBatchLike,
  context: VmsImportBatchDuplicateContext = {},
): VmsImportBatchStatus {
  const reportType = reportTypeValue(batch);
  const status = normalizedStatus(batch);
  const importedRows = batchImportedRows(batch);
  const rowsFound = Math.max(0, Math.floor(Number(batch.rows_found ?? batch.row_count ?? 0) || 0));
  const hasUsableRows = importedRows > 0 || rowsFound > 0;
  const needsMapping = Number(batch.rows_needing_review ?? 0) > 0;
  const deleted = Boolean(batch.deleted_at) || status === "deleted";
  const disabled = status === "disabled" || Boolean(batch.disabled_at);
  const active = isActiveImportedVmsBatch(batch);
  const unsupported = reportType ? !isSupportedImportReportType(reportType) : true;
  const duplicateGroupSize = Number(context.sameFileHashGroupSize ?? 1);
  const duplicateActiveCount = Number(context.sameFileHashActiveCount ?? 0);
  const duplicateDeletedCount = Number(context.sameFileHashDeletedCount ?? 0);
  const representativeId = context.sameFileHashRepresentativeId ?? null;
  const representativeLabel = context.sameFileHashRepresentativeFileName ?? null;
  const isRepresentative = Boolean(representativeId && representativeId === batch.id);

  if (status && !knownImportStatuses.has(status)) {
    return {
      action: 'review_mappings',
      actionLabel: 'Review file',
      activeInDashboard: false,
      key: 'needs_review',
      label: 'Needs review',
      relatedBatchId: null,
      reason: 'This file needs review because its status is unknown or incomplete.',
      secondaryAction: 'none',
      secondaryActionLabel: null,
    };
  }

  if (unsupported) {
    return {
      action: "none",
      actionLabel: null,
      activeInDashboard: false,
      key: "unsupported",
      label: "Unsupported file",
      relatedBatchId: null,
      reason: "This file type does not feed the dashboard yet.",
      secondaryAction: "none",
      secondaryActionLabel: null,
    };
  }

  if (deleted) {
    if (duplicateGroupSize > 1 && duplicateActiveCount > 0) {
      return {
        action: "view_existing",
        actionLabel: "Open active copy",
        activeInDashboard: false,
        key: "deleted_duplicate_active",
        label: "Deleted import file",
        relatedBatchId: representativeId,
        reason: representativeLabel
          ? `This deleted batch matches ${representativeLabel}, which is already active in the dashboard.`
          : "This deleted batch matches another active file that is already feeding the dashboard.",
        secondaryAction: "import_as_new_active",
        secondaryActionLabel: "Import as new active batch",
      };
    }

    if (duplicateGroupSize > 1 && duplicateDeletedCount > 0) {
      return {
        action: "restore",
        actionLabel: "Restore deleted batch",
        activeInDashboard: false,
        key: "duplicate_deleted",
        label: "Deleted import file",
        relatedBatchId: representativeId,
        reason: representativeLabel
          ? `This file matches deleted source ${representativeLabel}. Restore the deleted batch or import it again as a new active batch.`
          : "This file matches a deleted source. Restore the deleted batch or import it again as a new active batch.",
        secondaryAction: "import_as_new_active",
        secondaryActionLabel: "Import as new active batch",
      };
    }

    return {
      action: hasUsableRows ? "restore" : "reprocess",
      actionLabel: hasUsableRows ? "Restore deleted batch" : "Reprocess file",
      activeInDashboard: false,
      key: "deleted",
      label: "Deleted import file",
      relatedBatchId: null,
      reason: hasUsableRows
        ? "This file was soft-deleted, so its rows are not included in the dashboard."
        : "This file was soft-deleted before any usable rows were kept.",
      secondaryAction: hasUsableRows ? "import_as_new_active" : "none",
      secondaryActionLabel: hasUsableRows ? "Import as new active batch" : null,
    };
  }

  if (status === "failed") {
    return {
      action: "reprocess",
      actionLabel: hasUsableRows ? "Reprocess file" : "Reprocess file",
      activeInDashboard: false,
      key: "failed",
      label: "Import failed",
      relatedBatchId: null,
      reason: hasUsableRows
        ? "The import failed, but saved rows or metadata still exist and can be repaired."
        : "The import failed before any usable rows were saved.",
      secondaryAction: "none",
      secondaryActionLabel: null,
    };
  }

  if (duplicateGroupSize > 1 && duplicateActiveCount > 0) {
    if (isRepresentative && active) {
      return {
        action: needsMapping ? "review_mappings" : "none",
        actionLabel: needsMapping ? "Review mappings" : null,
        activeInDashboard: true,
        key: "already_active",
        label: "Active in dashboard",
        relatedBatchId: representativeId,
        reason: representativeLabel
          ? `This batch is the active copy of ${representativeLabel} and is already feeding the dashboard.`
          : "This batch is already the active copy in the dashboard.",
        secondaryAction: "none",
        secondaryActionLabel: null,
      };
    }

    return {
      action: "view_existing",
      actionLabel: "Open active copy",
      activeInDashboard: false,
      key: "duplicate_active",
      label: "Duplicate active file",
      relatedBatchId: representativeId,
      reason: representativeLabel
        ? `Another active copy of ${representativeLabel} is already feeding the dashboard.`
        : "Another active copy of this file is already feeding the dashboard.",
      secondaryAction: "import_as_new_active",
      secondaryActionLabel: "Import as new active batch",
    };
  }

  if (duplicateGroupSize > 1 && duplicateDeletedCount > 0) {
    return {
      action: "restore",
      actionLabel: "Restore deleted batch",
      activeInDashboard: false,
      key: "duplicate_deleted",
      label: "Deleted import file",
      relatedBatchId: representativeId,
      reason: representativeLabel
        ? `This file matches deleted source ${representativeLabel}. Restore the deleted batch or import it again as a new active batch.`
        : "This file matches a deleted source. Restore the deleted batch or import it again as a new active batch.",
      secondaryAction: "import_as_new_active",
      secondaryActionLabel: "Import as new active batch",
    };
  }

  if (disabled) {
    return {
      action: hasUsableRows ? "restore" : "reprocess",
      actionLabel: hasUsableRows ? "Activate file" : "Reprocess file",
      activeInDashboard: false,
      key: "disabled",
      label: hasUsableRows ? "Inactive file" : "Inactive file",
      relatedBatchId: null,
      reason: batch.disable_reason
        ? `This file was disabled: ${batch.disable_reason}`
        : "This file is inactive and not contributing to dashboards.",
      secondaryAction: hasUsableRows ? "reprocess" : "none",
      secondaryActionLabel: hasUsableRows ? "Reprocess file" : null,
    };
  }

  if (status === "previewed" || status === "draft" || status === "cancelled" || status === "canceled") {
    return {
      action: hasUsableRows ? "finalize" : "reprocess",
      actionLabel: hasUsableRows ? "Finalize file" : "Reprocess file",
      activeInDashboard: false,
      key: "needs_finalization",
      label: "Needs finalization",
      relatedBatchId: null,
      reason: hasUsableRows
        ? "Rows were saved, but this batch is not active in the dashboard yet."
        : "This batch is still waiting to be finalized.",
      secondaryAction: hasUsableRows ? "reprocess" : "none",
      secondaryActionLabel: hasUsableRows ? "Reprocess file" : null,
    };
  }

  if (active) {
    return {
      action: needsMapping ? "review_mappings" : "none",
      actionLabel: needsMapping ? "Review mappings" : null,
      activeInDashboard: true,
      key: needsMapping ? "active_needs_mapping" : "active",
      label: "Active in dashboard",
      relatedBatchId: null,
      reason: needsMapping
        ? "Rows are imported and active, but some mappings still need review."
        : "Rows are imported and available in the dashboard.",
      secondaryAction: "none",
      secondaryActionLabel: null,
    };
  }

  if (hasUsableRows) {
    return {
      action: "finalize",
      actionLabel: "Finalize file",
      activeInDashboard: false,
      key: "imported_inactive",
      label: "Needs finalization",
      relatedBatchId: null,
      reason: "Rows were saved, but the batch is not active in the dashboard.",
      secondaryAction: "reprocess",
      secondaryActionLabel: "Reprocess file",
    };
  }

  return {
    action: "reprocess",
    actionLabel: "Reprocess file",
    activeInDashboard: false,
    key: "no_usable_rows",
    label: "No usable rows",
    relatedBatchId: null,
    reason: "This file did not produce any usable rows yet.",
    secondaryAction: "none",
    secondaryActionLabel: null,
  };
}







