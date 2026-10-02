import { LocalDraftForm } from "@/components/LocalDraft";
import { FormField, FormSection, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import {
  LocationPipelineLeadRow,
  locationPipelinePlaceTypeLabel,
  locationPipelinePlaceTypes,
  locationPipelinePriorityLabel,
  locationPipelinePriorities,
  locationPipelineSourceLabel,
  locationPipelineSources,
  locationPipelineStatusLabel,
  locationPipelineStatuses,
} from "@/lib/location-pipeline";
import type { LocationPipelineContactUser } from "@/lib/location-pipeline-server";

type LocationPipelineFormProps = {
  action: (formData: FormData) => void | Promise<void>;
  contactUsers: LocationPipelineContactUser[];
  lead?: Partial<LocationPipelineLeadRow> | null;
  submitLabel: string;
  cancelHref: string;
  userId?: string | null;
  currentTeamMemberId?: string | null;
};

function userLabel(user: LocationPipelineContactUser) {
  return user.role ? `${user.full_name} (${user.role})` : user.full_name;
}

export function LocationPipelineForm({
  action,
  contactUsers,
  lead,
  submitLabel,
  cancelHref,
  userId,
  currentTeamMemberId,
}: LocationPipelineFormProps) {
  const selectedContactUserId = lead?.contacted_by_user_id ?? currentTeamMemberId ?? "";
  const selectedAssigneeId = lead?.assigned_to_user_id ?? "";
  const missingIds = [selectedContactUserId, selectedAssigneeId].filter(Boolean).filter((id) => !contactUsers.some((user) => user.id === id));
  const contactOptions = [
    ...missingIds.map((id) => ({ id, full_name: "Current assignee", role: null })),
    ...contactUsers,
  ].filter((user, index, list) => list.findIndex((candidate) => candidate.id === user.id) === index);
  const availableStatuses = lead?.converted_location_id ? locationPipelineStatuses : locationPipelineStatuses.filter((status) => status !== "machine_placed");

  return (
    <LocalDraftForm action={action} formType="location-pipeline-lead" draftKeyParts={[lead?.id ?? "new"]} userId={userId ?? null} className="space-y-5">
      {lead?.id ? <input type="hidden" name="id" value={lead.id} /> : null}

      {lead?.status ? (
        <div className="surface-card flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Current pipeline status</div>
            <div className="mt-2"><StatusBadge status={lead.status} /></div>
          </div>
          {lead?.imported_source ? <div className="text-xs text-slate-500">Imported from {lead.imported_source}</div> : null}
          {lead?.converted_location_id ? (
            <div className="text-sm text-emerald-700">Linked to active location <span className="font-semibold">{lead.converted_location_id.slice(0, 8)}</span>.</div>
          ) : null}
        </div>
      ) : null}

      <FormSection title="Place details" description="Track where the opportunity is and whether it is worth a Snacky machine before it becomes an active location.">
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label="Place name" required>
            <input required name="place_name" defaultValue={lead?.place_name ?? ""} className="field-input" placeholder="School, hospital, university, company..." />
          </FormField>
          <FormField label="Place type" required>
            <select name="place_type" defaultValue={lead?.place_type ?? "other"} className="field-input">
              {locationPipelinePlaceTypes.map((placeType) => <option key={placeType} value={placeType}>{locationPipelinePlaceTypeLabel(placeType)}</option>)}
            </select>
          </FormField>
          <FormField label="City"><input name="city" defaultValue={lead?.city ?? ""} className="field-input" placeholder="Tripoli" /></FormField>
          <FormField label="Area"><input name="area" defaultValue={lead?.area ?? ""} className="field-input" placeholder="Ain Zara / Hay Al Andalus..." /></FormField>
          <FormField label="Estimated traffic" hint="Students, employees, visitors, or approximate daily traffic.">
            <input type="number" min="0" step="1" name="estimated_traffic" defaultValue={lead?.estimated_traffic ?? ""} className="field-input" placeholder="600" />
          </FormField>
          <FormField label="Rent expectation"><input type="number" min="0" step="0.01" name="rent_expectation" defaultValue={lead?.rent_expectation ?? ""} className="field-input" placeholder="500.00" /></FormField>
          <FormField label="Google Maps URL" hint="Useful for the field visit."><input name="google_maps_url" defaultValue={lead?.google_maps_url ?? ""} className="field-input" placeholder="https://maps.google.com/..." /></FormField>
          <FormField label="Address"><textarea name="address_text" rows={4} defaultValue={lead?.address_text ?? ""} className="field-input" placeholder="Street, building, landmark, parking notes..." /></FormField>
        </div>
      </FormSection>

      <FormSection title="CRM ownership" description="Customer support can capture the lead, then assign the next step to the person who will visit or follow up.">
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label="Lead source">
            <select name="source" defaultValue={lead?.source ?? "manual"} className="field-input">
              {locationPipelineSources.map((source) => <option key={source} value={source}>{locationPipelineSourceLabel(source)}</option>)}
            </select>
          </FormField>
          <FormField label="Priority">
            <select name="priority" defaultValue={lead?.priority ?? "normal"} className="field-input">
              {locationPipelinePriorities.map((priority) => <option key={priority} value={priority}>{locationPipelinePriorityLabel(priority)}</option>)}
            </select>
          </FormField>
          <FormField label="Assigned to" hint="The person responsible for the next action or visit.">
            <select name="assigned_to_user_id" defaultValue={selectedAssigneeId} className="field-input">
              <option value="">Unassigned</option>
              {contactOptions.map((user) => <option key={user.id} value={user.id}>{userLabel(user)}</option>)}
            </select>
          </FormField>
          <FormField label="Originally contacted / added by">
            <select name="contacted_by_user_id" defaultValue={selectedContactUserId} className="field-input">
              <option value="">Not recorded</option>
              {contactOptions.map((user) => <option key={user.id} value={user.id}>{userLabel(user)}</option>)}
            </select>
          </FormField>
          <FormField label="Status" required>
            <select name="status" defaultValue={lead?.status ?? "want_to_contact"} className="field-input">
              {availableStatuses.map((status) => <option key={status} value={status}>{locationPipelineStatusLabel(status)}</option>)}
            </select>
          </FormField>
          <FormField label="Next action" hint="Every active lead should have a clear next step.">
            <input name="next_action" defaultValue={lead?.next_action ?? ""} className="field-input" placeholder="Call manager / Visit site / Send proposal / Wait for reply" />
          </FormField>
          <FormField label="Next action date"><input type="date" name="next_action_date" defaultValue={lead?.next_action_date ?? lead?.next_follow_up_date ?? ""} className="field-input" /></FormField>
        </div>
      </FormSection>

      <FormSection title="Contact" description="Keep the decision-maker details in one place so another teammate can continue the conversation.">
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label="Contact person"><input name="contact_person_name" defaultValue={lead?.contact_person_name ?? ""} className="field-input" placeholder="Primary contact" /></FormField>
          <FormField label="Job title"><input name="contact_person_job_title" defaultValue={lead?.contact_person_job_title ?? ""} className="field-input" placeholder="Owner / Manager / Marketing / Services" /></FormField>
          <FormField label="Phone"><input name="contact_phone" defaultValue={lead?.contact_phone ?? ""} className="field-input" placeholder="+218..." /></FormField>
          <FormField label="WhatsApp"><input name="contact_whatsapp" defaultValue={lead?.contact_whatsapp ?? ""} className="field-input" placeholder="+218..." /></FormField>
          <FormField label="First contact date"><input type="date" name="first_contact_date" defaultValue={lead?.first_contact_date ?? ""} className="field-input" /></FormField>
          <FormField label="Last contact date"><input type="date" name="last_contact_date" defaultValue={lead?.last_contact_date ?? ""} className="field-input" /></FormField>
          <input type="hidden" name="next_follow_up_date" value={lead?.next_follow_up_date ?? ""} />
          <FormField label="Rejection / pause reason" hint="Use when the lead is rejected or paused.">
            <input name="rejection_reason" defaultValue={lead?.rejection_reason ?? ""} className="field-input" placeholder="No traffic / rent too high / management declined / call next term" />
          </FormField>
        </div>
      </FormSection>

      <FormSection title="Notes" description="Commercial context that should remain visible regardless of who handles the next follow-up.">
        <FormField label="Internal notes">
          <textarea name="notes" rows={6} defaultValue={lead?.notes ?? ""} className="field-input" placeholder="Meeting notes, objections, suggested machine type, competitor presence, school size..." />
        </FormField>
      </FormSection>

      <div className="flex flex-col gap-3 sm:flex-row">
        <PrimaryButton>{submitLabel}</PrimaryButton>
        <SecondaryButton href={cancelHref}>Cancel</SecondaryButton>
      </div>
    </LocalDraftForm>
  );
}
