export type RouteRecommendationDiagnosticReasonCode =
  | "healthy"
  | "no_active_stock_snapshot"
  | "no_latest_stock_rows"
  | "machine_mapping_missing"
  | "machine_has_no_planogram"
  | "all_products_unmapped"
  | "all_products_inactive"
  | "current_stock_full"
  | "no_positive_recommendations"
  | "unknown";

export type RouteRecommendationMachineDiagnostic = {
  machineId: string;
  machineName: string;
  machineCode: string;
  locationName: string | null;
  machineMapped: boolean;
  latestStockRowsFound: number;
  planogramRowsFound: number;
  recommendationRowsGenerated: number;
  routeVisibleRecommendationRows: number;
  positiveSuggestedRows: number;
  storageShortages: number;
  unmappedProducts: number;
  sourceFileName: string | null;
  snapshotTime: string | null;
  reasonCode: RouteRecommendationDiagnosticReasonCode;
  reasonLabel: string;
  reasonMessage: string;
};

export type RouteRecommendationDiagnostics = {
  summaryReasonCode: RouteRecommendationDiagnosticReasonCode;
  summaryReasonLabel: string;
  summaryMessage: string;
  activeStockBatchId: string | null;
  activeStockBatchFileName: string | null;
  activeStockBatchImportedAt: string | null;
  diagnosticBatchId: string | null;
  diagnosticBatchFileName: string | null;
  diagnosticBatchStatus: string | null;
  diagnosticBatchIsActive: boolean | null;
  latestStockRowsFound: number;
  recommendationRowsFound: number;
  recommendationsReturnedToFrontend: number;
  inactiveProductRowsFilteredOut: number;
  storageShortageRows: number;
  unmappedProductRows: number;
  planogramRowsFound: number;
  previewBatchRowsDetected: boolean;
  machineDiagnostics: RouteRecommendationMachineDiagnostic[];
};
