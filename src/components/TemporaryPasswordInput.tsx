"use client";

import { useState } from "react";

function generateTemporaryPassword() {
  return `Snacky-${Math.floor(10000 + Math.random() * 90000)}!`;
}

export function TemporaryPasswordInput({ defaultEnabled = false }: { defaultEnabled?: boolean }) {
  const [enabled, setEnabled] = useState(defaultEnabled);
  const [password, setPassword] = useState("");

  const generate = () => setPassword(generateTemporaryPassword());

  return (
    <div className="space-y-4">
      <label className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-4">
        <input
          name="create_login_access"
          type="checkbox"
          value="yes"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          className="mt-1"
        />
        <span>
          <span className="block text-sm font-semibold text-slate-900">Create login access</span>
          <span className="text-sm text-slate-500">Create or reset this user's Supabase Auth account with a temporary password.</span>
        </span>
      </label>

      {enabled ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <label className="block space-y-1">
              <span className="text-sm font-medium text-slate-800">Temporary password</span>
              <input
                name="temporary_password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="field-input bg-white"
                placeholder="Snacky-48291!"
                required={enabled}
              />
            </label>
            <button type="button" onClick={generate} className="btn-secondary">
              Generate temporary password
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-500">Use a strong but readable temporary password. It will only be shown after creation or reset.</p>
        </div>
      ) : null}
    </div>
  );
}
