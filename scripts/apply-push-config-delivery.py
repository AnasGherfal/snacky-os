from pathlib import Path

path = Path(__file__).resolve().parents[1] / "src/lib/notification-delivery.ts"
source = path.read_text(encoding="utf-8-sig")

replacements = [
    (
        'import { getSupabaseAdminClient } from "@/lib/supabase-server";\n',
        'import { getSupabaseAdminClient } from "@/lib/supabase-server";\nimport { configureWebPush } from "@/lib/push-config";\n',
        "push config import",
    ),
    (
        '  const vapid = ensureWebPushConfigured();\n  if (!vapid) {\n    return { sent: false, skipped: "missing_vapid_configuration" as const };\n  }',
        '  const vapid = await configureWebPush(supabase);\n  if (!vapid.configured) {\n    return { sent: false, skipped: "missing_vapid_configuration" as const, reason: vapid.reason };\n  }',
        "push delivery configuration",
    ),
]

for old, new, label in replacements:
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    source = source.replace(old, new, 1)

path.write_text(source, encoding="utf-8")
print("Push delivery integration applied.")
