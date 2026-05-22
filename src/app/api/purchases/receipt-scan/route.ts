import { NextResponse } from "next/server";
import { getCurrentProfile } from "@/lib/auth";
import { canScanReceipts } from "@/lib/authz";
import { RECEIPT_MAX_SIZE, RECEIPT_MIME_TYPES, resolvePurchaseReceiptUrl } from "@/lib/purchase-receipts";
import { buildReceiptScanDraft, extractReceipt, RECEIPT_SCAN_NOT_CONFIGURED_MESSAGE } from "@/lib/receipt-scan-server";
import { getSupabaseServerClient } from "@/lib/supabase-server";

function receiptFileError(file: FormDataEntryValue | null) {
  if (!(file instanceof File) || file.size === 0) return "Upload a receipt image or PDF.";
  if (!RECEIPT_MIME_TYPES.includes(file.type) || file.size > RECEIPT_MAX_SIZE) {
    return "Receipt must be a PNG, JPG, WEBP, or PDF file that is 5MB or smaller.";
  }
  return "";
}

export async function POST(request: Request) {
  try {
    const profile = await getCurrentProfile();
    if (!profile || profile.active_status !== "active" || !canScanReceipts(profile)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const supabase = getSupabaseServerClient();
    if (!supabase) {
      return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
    }

    const formData = await request.formData();
    const file = formData.get("receipt_file");
    const validationError = receiptFileError(file);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const uploadForm = new FormData();
    uploadForm.set("receipt_file", file as File);
    uploadForm.set("receipt_number", "receipt-scan");
    const { receiptUrl, uploadUnavailable, uploadError } = await resolvePurchaseReceiptUrl(supabase, uploadForm);

    const scan = await extractReceipt(file as File);
    const userMessage =
      scan.status === "not_configured"
        ? RECEIPT_SCAN_NOT_CONFIGURED_MESSAGE
        : scan.status === "failed"
          ? "Receipt scanning failed. You can still enter purchase manually."
          : scan.errorMessage;
    const draft = await buildReceiptScanDraft({
      supabase,
      extraction: scan.extraction,
      fileUrl: receiptUrl,
      fileName: (file as File).name || null,
      fileType: (file as File).type || null,
      status: scan.status,
      message: userMessage,
    });

    let scanResultId: string | null = null;
    const { data: scanResult, error: scanResultError } = await supabase
      .from("receipt_scan_results")
      .insert({
        purchase_id: null,
        file_url: receiptUrl,
        raw_text: scan.extraction.rawText,
        extracted_data: {
          provider: scan.provider,
          file_name: (file as File).name || null,
          file_type: (file as File).type || null,
          extraction: scan.extraction,
          matched_draft: draft,
        },
        status: scan.status,
        error_message: scan.errorMessage,
        created_by: profile.team_member_id,
      })
      .select("id")
      .single();

    if (scanResultError) {
      console.warn("[receipt-scan] Could not save scan result", scanResultError);
    } else {
      scanResultId = scanResult?.id ?? null;
    }

    return NextResponse.json({
      draft: { ...draft, scanResultId },
      uploadWarning:
        uploadError === "invalid_file"
          ? "Receipt upload must be a PNG, JPG, WEBP, or PDF file that is 5MB or smaller."
          : uploadUnavailable
            ? "Receipt storage is unavailable. The scan can still be reviewed, but the file was not saved."
            : "",
    });
  } catch (error) {
    console.error("[receipt-scan] Unexpected scan failure", error);
    return NextResponse.json({ error: "Could not scan receipt. You can still enter the purchase manually." }, { status: 500 });
  }
}
