import assert from 'node:assert/strict';

/** Wait for this task's real command receipt, never for text already in an input. */
export async function saveTaskThroughUi(page, taskId) {
  const responsePromise = page.waitForResponse(response => {
    const request = response.request();
    if (new URL(response.url()).pathname !== '/api/crm/command' || request.method() !== 'POST') return false;
    try {
      const payload = request.postDataJSON();
      return payload.action === 'task.save' && payload.recordId === taskId;
    } catch { return false; }
  }, { timeout: 30000 });
  const [response] = await Promise.all([
    responsePromise,
    page.getByRole('button', { name: 'Save changes', exact: true }).click(),
  ]);
  assert.equal(response.ok(), true, `Task save returned HTTP ${response.status()}`);
  const result = await response.json();
  assert.equal(result.ok, true, result.message ?? 'Task save did not confirm success');
  assert.equal(result.commandId, response.request().postDataJSON().id, 'Task command receipt mismatch');
  assert.equal(result.id, taskId, 'Saved another task');
  assert.equal(result.kind, 'task', 'Unexpected saved record type');
}
