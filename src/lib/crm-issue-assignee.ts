export type IssueAssignmentSummary = {
  issue_id: string;
  field_task_id: string | null;
  operator_id: string | null;
  operator_name: string | null;
  dispatch_state: string | null;
};

type IssueRow = {
  data?: {
    issue_type?: string;
    customer_name?: string | null;
    customer_phone?: string | null;
    customer_whatsapp?: string | null;
    contact_channel?: string | null;
  };
};

/** Presentation only. Never alter the CRM owner, creator, permissions or task. */
export function crmIssueAssignee(
  row: IssueRow,
  assignment: IssueAssignmentSummary | undefined,
  ar: boolean,
  crmOwnerName?: string | null,
): { label: string; name: string } {
  const tr = (en: string, arabic: string) => ar ? arabic : en;
  if (!assignment) return {
    label: tr('Assignment', 'المسؤول'),
    name: tr('Assignment unavailable — refresh', 'تعذر تحميل المسؤول — حدّث الصفحة'),
  };
  const data = row.data ?? {};
  const machineOnly = data.issue_type === 'machine_unavailable'
    && data.contact_channel === 'other'
    && ![data.customer_name, data.customer_phone, data.customer_whatsapp]
      .some(value => String(value ?? '').trim());
  if (assignment.field_task_id || machineOnly) return {
    label: tr('Assigned operator', 'المشغّل المسؤول'),
    name: assignment.operator_id
      ? assignment.operator_name || tr('Operator name unavailable', 'اسم المشغّل غير متاح')
      : tr('Unassigned — waiting for operator', 'غير مسند — بانتظار مشغّل'),
  };
  return {
    label: tr('CRM owner', 'مسؤول علاقات العملاء'),
    name: crmOwnerName || tr('Unassigned', 'غير معيّن'),
  };
}
