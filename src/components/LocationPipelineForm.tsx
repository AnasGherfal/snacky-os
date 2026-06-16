import { LocalDraftForm } from "@/components/LocalDraft";
import { FormField, FormSection, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/ui";
import { LocationPipelineLeadRow, locationPipelinePlaceTypeLabel, locationPipelinePlaceTypes, locationPipelineStatusLabel, locationPipelineStatuses } from "@/lib/location-pipeline";
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
  const contactOptions =
    selectedContactUserId && !contactUsers.some((user) => user.id === selectedContactUserId)
      ? [{ id: selectedContactUserId, full_name: "Current assignee", role: null }, ...contactUsers]
      : contactUsers;
  const availableStatuses = lead?.converted_location_id ? locationPipelineStatuses : locationPipelineStatuses.filter((status) => status !== "machine_placed");

  return (
    <LocalDraftForm action={action} formType="location-pipeline-lead" draftKeyParts={[lead?.id ?? "new"]} userId={userId ?? null} className="space-y-5">
      {lead?.id ? <input type="hidden" name="id" value={lead.id} /> : null}

      {lead?.status ? (
        <div className="surface-card flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Current pipeline status</div>
            <div className="mt-2">
              <StatusBadge status={lead.status} />
            </div>
          </div>
          {lead?.converted_location_id ? (
            <div className="text-sm text-emerald-700">
              Linked to active location <span className="font-semibold">{lead.converted_location_id.slice(0, 8)}</span>.
            </div>
          ) : null}
        </div>
      ) : null}

      <FormSection title="Place details" description="Track where the location is, what kind of venue it is, and the commercial signal before a machine is installed.">
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label="Place name" required>
            <input required name="place_name" defaultValue={lead?.place_name ?? ""} className="field-input" placeholder="HT Land" />
          </FormField>
          <FormField label="Place type" required>
            <select name="place_type" defaultValue={lead?.place_type ?? "other"} className="field-input">
              {locationPipelinePlaceTypes.map((placeType) => (
                <option key={placeType} value={placeType}>
                  {locationPipelinePlaceTypeLabel(placeType)}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="City">
            <input name="city" defaultValue={lead?.city ?? ""} className="field-input" placeholder="Tripoli" />
          </FormField>
          <FormField label="Area">
            <input name="area" defaultValue={lead?.area ?? ""} className="field-input" placeholder="Hay Al Andalus" />
          </FormField>
          <FormField label="Estimated traffic">
            <input type="number" min="0" step="1" name="estimated_traffic" defaultValue={lead?.estimated_traffic ?? ""} className="field-input" placeholder="250" />
          </FormField>
          <FormField label="Rent expectation">
            <input type="number" min="0" step="0.01" name="rent_expectation" defaultValue={lead?.rent_expectation ?? ""} className="field-input" placeholder="500.00" />
          </FormField>
          <FormField label="Google Maps URL" hint="Optional map link for later site visits.">
            <input name="google_maps_url" defaultValue={lead?.google_maps_url ?? ""} className="field-input" placeholder="https://maps.google.com/..." />
          </FormField>
          <FormField label="Address">
            <textarea name="address_text" rows={4} defaultValue={lead?.address_text ?? ""} className="field-input" placeholder="Street, building, floor, parking notes..." />
          </FormField>
        </div>
      </FormSection>

      <FormSection title="Contact and follow-up" description="Keep the expansion conversation clear so the next teammate knows who was contacted and what the next step is.">
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label="Contact person">
            <input name="contact_person_name" defaultValue={lead?.contact_person_name ?? ""} className="field-input" placeholder="Primary contact" />
          </FormField>
          <FormField label="Job title">
            <input name="contact_person_job_title" defaultValue={lead?.contact_person_job_title ?? ""} className="field-input" placeholder="Owner / Manager / Admin" />
          </FormField>
          <FormField label="Phone">
            <input name="contact_phone" defaultValue={lead?.contact_phone ?? ""} className="field-input" placeholder="+218..." />
          </FormField>
          <FormField label="WhatsApp">
            <input name="contact_whatsapp" defaultValue={lead?.contact_whatsapp ?? ""} className="field-input" placeholder="+218..." />
          </FormField>
          <FormField label="Contacted by">
            <select name="contacted_by_user_id" defaultValue={selectedContactUserId} className="field-input">
              <option value="">No owner assigned yet</option>
              {contactOptions.map((user) => (
                <option key={user.id} value={user.id}>
                  {userLabel(user)}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Status" required>
            <select name="status" defaultValue={lead?.status ?? "want_to_contact"} className="field-input">
              {availableStatuses.map((status) => (
                <option key={status} value={status}>
                  {locationPipelineStatusLabel(status)}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="First contact date">
            <input type="date" name="first_contact_date" defaultValue={lead?.first_contact_date ?? ""} className="field-input" />
          </FormField>
          <FormField label="Last contact date">
            <input type="date" name="last_contact_date" defaultValue={lead?.last_contact_date ?? ""} className="field-input" />
          </FormField>
          <FormField label="Next follow-up date">
            <input type="date" name="next_follow_up_date" defaultValue={lead?.next_follow_up_date ?? ""} className="field-input" />
          </FormField>
          <FormField label="Rejection reason" hint="Only fill this when the lead is rejected or paused for a clear reason.">
            <input name="rejection_reason" defaultValue={lead?.rejection_reason ?? ""} className="field-input" placeholder="No footfall / rent too high / management declined" />
          </FormField>
        </div>
      </FormSection>

      <FormSection title="Notes" description="Store the latest meeting summary, objections, and commercial context.">
        <div className="grid gap-4">
          <FormField label="Internal notes">
            <textarea name="notes" rows={6} defaultValue={lead?.notes ?? ""} className="field-input" placeholder="Meeting notes, objections, suggested machine type, photos taken, competitor presence..." />
          </FormField>
        </div>
      </FormSection>

      <div className="flex flex-col gap-3 sm:flex-row">
        <PrimaryButton>{submitLabel}</PrimaryButton>
        <SecondaryButton href={cancelHref}>Cancel</SecondaryButton>
      </div>
    </LocalDraftForm>
  );
}
