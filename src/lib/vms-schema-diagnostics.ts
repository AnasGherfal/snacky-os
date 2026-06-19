export type VmsSchemaRelationKind = "table" | "view";

export type VmsSchemaRelation = {
  name: string;
  kind: VmsSchemaRelationKind;
  requiredFor: string;
};

export type VmsSupabaseError = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
};

export type VmsSchemaIssue =
  | { type: "permission"; relation?: string | null; column?: string | null }
  | { type: "missing_relation"; relation: string; column?: string | null }
  | { type: "missing_column"; relation?: string | null; column: string }
  | { type: "schema_cache"; relation?: string | null; column?: string | null }
  | null;

export const VMS_IMPORT_PIPELINE_RELATIONS: VmsSchemaRelation[] = [
  { name: "vms_import_batches", kind: "table", requiredFor: "batch metadata and import history" },
  { name: "vms_import_previews", kind: "table", requiredFor: "uploaded file preview payloads" },
  { name: "vms_import_preview_rows", kind: "table", requiredFor: "preview row diagnostics and batch links" },
  { name: "vms_import_rows", kind: "table", requiredFor: "final imported row audit" },
  { name: "vms_sales_raw", kind: "table", requiredFor: "summary sales imports" },
  { name: "vms_transactions_raw", kind: "table", requiredFor: "detailed order transaction imports" },
  { name: "vms_stock_snapshots", kind: "table", requiredFor: "stock imports and refill recommendations" },
  { name: "vms_machine_stock_snapshots", kind: "table", requiredFor: "machine goods inventory import audit" },
  { name: "vms_sales_snapshots", kind: "table", requiredFor: "legacy sales reconciliation" },
  { name: "vms_product_mappings", kind: "table", requiredFor: "saved product mappings" },
  { name: "vms_machine_mappings", kind: "table", requiredFor: "saved machine mappings" },
  { name: "vms_header_mappings", kind: "table", requiredFor: "saved header mappings" },
  { name: "products", kind: "table", requiredFor: "product validation" },
  { name: "machines", kind: "table", requiredFor: "machine validation" },
  { name: "vms_sales_clean", kind: "view", requiredFor: "sales KPI dashboards" },
  { name: "latest_vms_stock_by_slot", kind: "view", requiredFor: "refill recommendations" },
];

export const VMS_IMPORT_REQUIRED_TABLES = VMS_IMPORT_PIPELINE_RELATIONS
  .filter((relation) => relation.kind === "table")
  .map((relation) => relation.name);

export function queryNameToRelation(queryName?: string | null) {
  if (!queryName) return null;
  const relation = queryName.split(".")[0]?.trim();
  return relation || null;
}

export function normalizeSupabaseError(error: unknown): VmsSupabaseError | null {
  if (!error || typeof error !== "object") return null;
  return error as VmsSupabaseError;
}

export function extractVmsSchemaIssue(error: unknown, queryName?: string | null): VmsSchemaIssue {
  const supabaseError = normalizeSupabaseError(error);
  if (!supabaseError) return null;

  const code = String(supabaseError.code ?? "");
  const rawText = [
    supabaseError.code,
    supabaseError.message,
    supabaseError.details,
    supabaseError.hint,
  ]
    .filter(Boolean)
    .join(" ");
  const text = rawText.toLowerCase();
  const queryRelation = queryNameToRelation(queryName);

  if (code === "42501" || text.includes("permission denied") || text.includes("row-level security") || text.includes("rls")) {
    return { type: "permission", relation: queryRelation };
  }

  const schemaColumnMatch =
    rawText.match(/could not find the ['"]([^'"]+)['"] column of ['"](?:public\.)?([^'"]+)['"]/i)
    ?? rawText.match(/column ['"]?(?:public\.)?([a-z0-9_]+)\.([a-z0-9_]+)['"]? does not exist/i);
  if (schemaColumnMatch) {
    if (schemaColumnMatch.length >= 3 && rawText.toLowerCase().includes(" column of ")) {
      return { type: "missing_column", column: schemaColumnMatch[1], relation: schemaColumnMatch[2] };
    }
    return { type: "missing_column", relation: schemaColumnMatch[1], column: schemaColumnMatch[2] };
  }

  const columnMatch = rawText.match(/column ['"]?([a-z0-9_]+)['"]? does not exist/i);
  if (columnMatch) return { type: "missing_column", relation: queryRelation, column: columnMatch[1] };

  const relationMatch =
    rawText.match(/relation ['"]?(?:public\.)?([a-z0-9_]+)['"]? does not exist/i)
    ?? rawText.match(/table ['"]?(?:public\.)?([a-z0-9_]+)['"]? does not exist/i)
    ?? rawText.match(/could not find the table ['"](?:public\.)?([^'"]+)['"]/i)
    ?? rawText.match(/could not find ['"](?:public\.)?([^'"]+)['"] in the schema cache/i);
  if (relationMatch) return { type: "missing_relation", relation: relationMatch[1] };

  if (code === "42P01" || code === "PGRST205") {
    return { type: "missing_relation", relation: queryRelation ?? "unknown relation" };
  }

  if (code === "42703" || code === "PGRST204" || text.includes("schema cache")) {
    return { type: "schema_cache", relation: queryRelation };
  }

  return null;
}

export function vmsSchemaIssueMessage(error: unknown, queryName?: string | null) {
  const issue = extractVmsSchemaIssue(error, queryName);
  if (!issue) return null;
  if (issue.type === "permission") {
    return "You do not have permission to load this VMS data.";
  }
  if (issue.type === "missing_relation") {
    return "VMS setup is incomplete. Please contact admin.";
  }
  if (issue.type === "missing_column") {
    return "VMS setup is missing a required field. Please contact admin.";
  }
  if (issue.type === "schema_cache") {
    return "VMS setup needs to be refreshed. Please contact admin.";
  }
  return null;
}
