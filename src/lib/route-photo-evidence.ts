/** Match exact reuse of uploaded photo bytes without inspecting people's pictures. */
export function photoEvidenceFingerprint(pathOrUrl: string | null | undefined): string | null {
  const value = String(pathOrUrl ?? "").split("?")[0].trim();
  if (!value) return null;
  const fileName = value.split("/").pop() ?? "";
  const match = fileName.match(/-([a-f0-9]{24})\.(?:jpg|jpeg|png|webp)$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

export function isDuplicateProofImage(
  compressor: { storagePath?: string | null; url?: string | null },
  completion: { storagePath?: string | null; url?: string | null },
): boolean {
  const compPath = compressor.storagePath?.trim() || compressor.url?.trim() || null;
  const finalPath = completion.storagePath?.trim() || completion.url?.trim() || null;
  if (!compPath || !finalPath) return false;
  if (compPath === finalPath) return true;
  const compressorFingerprint = photoEvidenceFingerprint(compPath);
  const completionFingerprint = photoEvidenceFingerprint(finalPath);
  return Boolean(compressorFingerprint && completionFingerprint && compressorFingerprint === completionFingerprint);
}
