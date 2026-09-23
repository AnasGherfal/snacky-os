/** Keep multipart uploads below the host's request limit; no application dependency. */
export const CASH_PHOTO_UPLOAD_LIMIT = 3 * 1024 * 1024;
export const CASH_PHOTO_INPUT_LIMIT = 10 * 1024 * 1024;
export async function prepareCashPhoto(file: File): Promise<File> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size === 0 || file.size > CASH_PHOTO_INPUT_LIMIT) throw Error('photo');
  if (file.size <= CASH_PHOTO_UPLOAD_LIMIT) return file;
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url; await image.decode();
    const ratio = Math.min(1, 2000 / Math.max(image.naturalWidth, image.naturalHeight));
    if (!Number.isFinite(ratio) || ratio <= 0) throw Error('photo');
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio)); canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const context = canvas.getContext('2d'); if (!context) throw Error('photo');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', .85));
    if (!blob || blob.size > CASH_PHOTO_UPLOAD_LIMIT) throw Error('photo');
    return new File([blob], 'cash-storage.jpg', { type: 'image/jpeg', lastModified: file.lastModified });
  } finally { URL.revokeObjectURL(url); }
}
