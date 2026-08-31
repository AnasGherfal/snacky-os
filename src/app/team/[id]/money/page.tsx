import { redirect } from "next/navigation";
import OperatorMoneyLedgerClient from "@/app/operator-money/OperatorMoneyLedgerClient";
import { ErrorState, PageHeader, SecondaryButton } from "@/components/ui";
import { getCurrentProfile } from "@/lib/auth";
import { isOwnerAdminRole } from "@/lib/authz";
import { getServerI18n } from "@/lib/i18n/server";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function TeamMemberMoneyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const path = `/team/${id}/money`;
  const profile = await getCurrentProfile();

  if (!profile) {
    redirect(`/login?next=${encodeURIComponent(path)}`);
  }

  const manager = isOwnerAdminRole(profile);
  const viewingSelf = Boolean(
    profile.team_member_id && profile.team_member_id === id,
  );

  if (!manager && !viewingSelf) {
    redirect("/unauthorized");
  }

  const { locale } = await getServerI18n();
  const ar = locale === "ar";
  const client = getSupabaseAdminClient();

  if (!client) {
    return (
      <ErrorState
        title={ar ? "تعذر فتح سجل الأموال" : "Money ledger unavailable"}
        body={ar ? "قاعدة البيانات غير مهيأة." : "Supabase is not configured."}
        action={
          <SecondaryButton href={`/team/${id}`}>
            {ar ? "العودة إلى الملف" : "Back to profile"}
          </SecondaryButton>
        }
      />
    );
  }

  const { data: member, error } = await client
    .from("team_members")
    .select("id, full_name")
    .eq("id", id)
    .maybeSingle();

  if (error || !member) {
    return (
      <ErrorState
        title={ar ? "عضو الفريق غير موجود" : "Team member not found"}
        body={
          ar
            ? "تعذر تحميل سجل الأموال لهذا الشخص."
            : "This person's money ledger could not be loaded."
        }
        action={
          <SecondaryButton href={manager ? "/team" : `/team/${id}`}>
            {ar ? "رجوع" : "Back"}
          </SecondaryButton>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          ar
            ? `سجل الأموال — ${member.full_name}`
            : `Money ledger — ${member.full_name}`
        }
        subtitle={
          ar
            ? "المشتريات الشخصية، دفعات الدين، أموال العمل، المصروفات والتسويات حسب الفترة."
            : "Personal purchases, debt payments, work money, expenses, and period settlements."
        }
        breadcrumbs={
          manager
            ? [
                { label: ar ? "الفريق" : "Team", href: "/team" },
                {
                  label: member.full_name,
                  href: `/team/${id}`,
                },
                { label: ar ? "الأموال" : "Money" },
              ]
            : [
                {
                  label: ar ? "ملفي" : "My profile",
                  href: `/team/${id}`,
                },
                { label: ar ? "أموالي" : "My money" },
              ]
        }
        action={
          <SecondaryButton href={`/team/${id}`}>
            {ar ? "العودة إلى الملف" : "Back to profile"}
          </SecondaryButton>
        }
      />

      <OperatorMoneyLedgerClient
        initialPersonId={id}
        lockPerson
        locale={locale}
        selfServiceOnly={viewingSelf && !manager}
      />
    </div>
  );
}
