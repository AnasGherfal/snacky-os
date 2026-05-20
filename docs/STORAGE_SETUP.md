# Snacky OS Storage Setup

Snacky OS uses Supabase Storage for product thumbnails, purchase receipts, and operational photos. The app must keep working when Storage is missing in a local environment, so upload forms fall back to URL fields instead of crashing.

## Buckets

| Bucket | Visibility | Used for | Notes |
| --- | --- | --- | --- |
| `product-images` | Public read | Product thumbnails | Public is intentional because catalog thumbnails render directly in the UI. |
| `receipt-images` | Private | Purchase receipt images/PDFs | Opened through authenticated signed URLs only. |
| `machine-photos` | Private | Machine reference/service photos | Do not expose as a public bucket. |
| `refill-photos` | Private | Operator refill proof photos | Object paths should start with the related route ID. |
| `issue-photos` | Private | Operator issue photos | Object paths should start with the related route ID. |

## Local Development

Local Storage is enabled in `supabase/config.toml`. Start Supabase without excluding Storage:

```bash
npx supabase start -x logflare,imgproxy,edge-runtime,supavisor
```

Do not include `storage` or `storage-api` in the exclude list.

If Storage is unavailable locally, product upload will show:

```text
Storage is not configured in this environment. Use image URL for now.
```

That fallback is expected and safe. Paste a public image URL for product thumbnails until local Storage is running.

Local development can point to staging Supabase when intentionally testing cloud Storage behavior. Do not point local upload testing at production unless you are doing a controlled production support task.

## Staging And Production

Staging must use the Supabase staging project and Vercel staging/Preview app. Production must use the Supabase production project and Vercel production app.

For each environment:

- Vercel env vars must use that environment's cloud Supabase URL and anon/publishable key.
- `SUPABASE_SERVICE_ROLE_KEY` must stay server-only.
- Auth redirect URLs must include the app domain where uploads and signed receipt links are tested.
- Run bucket migrations through `npx supabase db push`.
- Never run `supabase db reset` on production to repair Storage.

## Migrations And Policies

The migration `supabase/migrations/202605190001_storage_buckets_policies.sql` creates or updates all expected buckets when the Supabase Storage schema exists. It also installs Storage policies:

- `product-images` allows public reads and owner/admin writes.
- `receipt-images` is private; owner/admin can write and owner/admin/supervisor/warehouse/finance can read.
- `machine-photos` is private; active authenticated users can read and owner/admin can write.
- `refill-photos` and `issue-photos` are private; owner/admin/supervisor and the operator assigned to the route can read/write route-scoped files.

Route-scoped operator photo paths must start with the route UUID:

```text
refill-photos/<route-id>/<stop-id-or-file-name>.jpg
issue-photos/<route-id>/<issue-or-file-name>.jpg
```

## Upload Rules

Product images:

- Bucket: `product-images`
- Allowed types: PNG, JPG, WEBP
- Maximum size: 5MB
- Public thumbnail URLs are allowed

Purchase receipts:

- Bucket: `receipt-images`
- Allowed types: PNG, JPG, WEBP, PDF
- Maximum size: 5MB
- Stored privately and opened through `/api/storage/receipt-images/...`

Machine, refill, and issue photos:

- Buckets: `machine-photos`, `refill-photos`, `issue-photos`
- Keep buckets private by default
- Use signed URLs or authenticated API routes for access
- Do not make refill or issue buckets public unless the business intentionally accepts that exposure

## Production Checklist

Before staging or production:

1. Confirm `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and server-only `SUPABASE_SERVICE_ROLE_KEY` are configured in cloud environment variables.
2. Run migrations against the staging Supabase project first, then production after testing.
3. Confirm `product-images` is the only public bucket.
4. Confirm private bucket policies exist for receipts, machine photos, refill photos, and issue photos.
5. Upload a product image and verify the product thumbnail renders.
6. Upload a receipt image and a receipt PDF and verify the receipt opens only after app authentication.
7. Keep Supabase service role keys out of client components, browser bundles, and public env vars.
8. Confirm refill and issue photos are not publicly accessible by direct public URL.
