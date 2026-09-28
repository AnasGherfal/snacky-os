# CRM intake and prepared document kit

CRM home starts with the native `/issues/new` action before independently streamed notes, lead-focus and work summaries. The CRM module menu also provides New customer issue. The existing five-field form and its role, money and follow-up rules are unchanged.

## Real files, not placeholder publication

The owner/admin-only `/company/import` accepts `Snacky-Documents-Import.json` or the original PDF/PPTX files. The bundle is supplied separately in the conversation. The repository contains titles, sizes and SHA-256 identifiers, not private document bytes. Selection performs no writes. The user reviews owner/date and explicitly chooses Add files to the internal library.

Files are matched against the prepared manifest, uploaded separately through the existing same-origin `/api/company/files`, downloaded and hashed again, then saved/published through `/api/company/command`. The kit-status endpoint is read-only and uses existing authenticated Company RPCs. No service client, new bucket, migration or direct table write is introduced.

Content-derived IDs prevent repeated imports from creating extra library records. Save/publish request IDs are actor/payload-bound. Existing published records remain unchanged; edited drafts require review. Failed runs retain completed files and resume with the same kit. Success requires a fresh read of the published records and verified attachments.

The six new PDF editions and six editable masters are for internal CRM/management preparation. Two earlier working/reference PDFs are management-only. No external-sharing approval is granted. The new profile review edition does not replace or inherit the older approved profile's approval.

## Verification

Focused tests execute real client handlers against synthetic responses; they do not assert a production import happened. Run these, typecheck, lint, build and every triggered PR workflow on the final head. After the owner imports, verify the actual private files and published records before reporting the library populated.
