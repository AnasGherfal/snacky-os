import { readCompanyBody } from '@/lib/company-request';
import { revalidatePath } from 'next/cache';
import { companySameOrigin, validCompanyCommand } from '@/lib/company-hub';
import {
  companySession,
  companyJson,
  companyFailure,
} from '@/lib/company-server';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  if (!companySameOrigin(request))
    return companyJson(
      { ok: false, message: 'Invalid request origin.', retryable: false },
      403,
    );
  const session = await companySession();
  if (!session)
    return companyJson(
      {
        ok: false,
        message:
          'Company hub is unavailable or this account is not authorized.',
        retryable: false,
      },
      403,
    );
  let command;
  try {
    const bytes = await readCompanyBody(request, 256000);
    command = validCompanyCommand(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'request_too_large'
    )
      return companyFailure(error);
    return companyJson(
      {
        ok: false,
        message: 'Check the form fields and try again.',
        retryable: false,
      },
      400,
    );
  }
  if (!['read', 'ack'].includes(command.action) && !session.manager)
    return companyJson(
      {
        ok: false,
        message: 'Management permission required.',
        retryable: false,
      },
      403,
    );
  try {
    const { data, error } = await session.db.rpc('snacky_company_command_v1', {
      p_request: command.request_id,
      p_action: command.action,
      p_id: command.item_id,
      p_revision: command.revision,
      p_version: command.version ?? null,
      p_payload: command.payload ?? {},
    });
    if (error) throw error;
    if (
      !data ||
      data.request_id !== command.request_id ||
      data.id !== command.item_id
    )
      throw new Error('Unconfirmed response');
    revalidatePath('/company', 'layout');
    return companyJson({ ok: true, ...data });
  } catch (error) {
    return companyFailure(error);
  }
}
