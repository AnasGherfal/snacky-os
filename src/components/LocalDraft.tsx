"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

type DraftStatus = "idle" | "dirty" | "saving" | "saved" | "restored" | "error";

type StoredDraft<T> = {
  version: 1;
  key: string;
  value: T;
  updatedAt: string;
};

type UseLocalDraftOptions<T> = {
  key: string | null;
  value: T;
  enabled?: boolean;
  debounceMs?: number;
  shouldSave?: (value: T) => boolean;
  onRestore: (value: T) => void;
  serialize?: (value: T) => unknown;
  deserialize?: (value: unknown) => T;
};

type FormControlDraft = {
  name: string;
  tagName: string;
  type: string;
  value: string;
  checked?: boolean;
  multipleValues?: string[];
};

type FileDraftMetadata = {
  name: string;
  size: number;
  type: string;
  lastModified: number;
};

type FormDraftValue = {
  controls: FormControlDraft[];
  files: Record<string, FileDraftMetadata[]>;
};

function sanitizeDraftPart(value: string | number | null | undefined) {
  return String(value ?? "none").trim().replace(/[^a-zA-Z0-9._:-]+/g, "-") || "none";
}

function parseStoredDraft<T>(raw: string, key: string, deserialize: (value: unknown) => T): StoredDraft<T> | null {
  const parsed = JSON.parse(raw) as Partial<StoredDraft<unknown>>;
  if (!parsed || parsed.version !== 1 || parsed.key !== key || !parsed.updatedAt) return null;
  return {
    version: 1,
    key,
    updatedAt: parsed.updatedAt,
    value: deserialize(parsed.value),
  };
}

function redirectTarget(error: unknown) {
  const digest = String((error as { digest?: unknown } | null)?.digest ?? "");
  if (!digest.startsWith("NEXT_REDIRECT")) return "";
  return digest.split(";")[2] ?? "";
}

export function useDraftUserId() {
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled) setUserId(data?.profile?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setUserId(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return userId;
}

export function useDraftKey(formType: string, parts: Array<string | number | null | undefined>, explicitUserId?: string | null) {
  const fetchedUserId = useDraftUserId();
  const userId = explicitUserId === undefined ? fetchedUserId : explicitUserId;

  return useMemo(() => {
    if (!userId) return null;
    return ["snacky", "draft", formType, ...parts, userId].map(sanitizeDraftPart).join(":");
  }, [formType, parts, userId]);
}

export function useLocalDraft<T>({
  key,
  value,
  enabled = true,
  debounceMs = 700,
  shouldSave = () => true,
  onRestore,
  serialize = (nextValue) => nextValue,
  deserialize = (nextValue) => nextValue as T,
}: UseLocalDraftOptions<T>) {
  const [status, setStatus] = useState<DraftStatus>("idle");
  const [pendingDraft, setPendingDraft] = useState<StoredDraft<T> | null>(null);
  const valueRef = useRef(value);
  const keyRef = useRef(key);
  const enabledRef = useRef(enabled);
  const clearedSnapshotRef = useRef<string | null>(null);
  const shouldSaveRef = useRef(shouldSave);
  const serializeRef = useRef(serialize);
  const deserializeRef = useRef(deserialize);
  const pendingDraftRef = useRef<StoredDraft<T> | null>(pendingDraft);

  useEffect(() => {
    valueRef.current = value;
    keyRef.current = key;
    enabledRef.current = enabled;
    shouldSaveRef.current = shouldSave;
    serializeRef.current = serialize;
    deserializeRef.current = deserialize;
    pendingDraftRef.current = pendingDraft;
  }, [deserialize, enabled, key, pendingDraft, serialize, shouldSave, value]);

  const clearDraft = useCallback(() => {
    const storageKey = keyRef.current;
    if (!storageKey || typeof window === "undefined") return;
    try {
      clearedSnapshotRef.current = JSON.stringify(serializeRef.current(valueRef.current));
    } catch {
      clearedSnapshotRef.current = null;
    }
    window.localStorage.removeItem(storageKey);
    setPendingDraft(null);
    setStatus("idle");
  }, []);

  const writeDraft = useCallback((nextValue = valueRef.current) => {
    const storageKey = keyRef.current;
    if (!storageKey || !enabledRef.current || typeof window === "undefined") return;
    if (pendingDraftRef.current) return;
    if (!shouldSaveRef.current(nextValue)) {
      window.localStorage.removeItem(storageKey);
      setStatus("idle");
      return;
    }

    try {
      const serializedValue = serializeRef.current(nextValue);
      const serializedSnapshot = JSON.stringify(serializedValue);
      if (clearedSnapshotRef.current === serializedSnapshot) return;
      clearedSnapshotRef.current = null;
      const stored: StoredDraft<unknown> = {
        version: 1,
        key: storageKey,
        value: serializedValue,
        updatedAt: new Date().toISOString(),
      };
      window.localStorage.setItem(storageKey, JSON.stringify(stored));
      setStatus("saved");
    } catch (error) {
      console.warn("[draft] Could not save local draft", { key: storageKey, error });
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    let nextPendingDraft: StoredDraft<T> | null = null;
    try {
      if (key && enabled && typeof window !== "undefined") {
        const raw = window.localStorage.getItem(key);
        if (raw) nextPendingDraft = parseStoredDraft(raw, key, deserializeRef.current);
      }
    } catch (error) {
      console.warn("[draft] Could not load local draft", { key, error });
    }

    if (typeof window === "undefined") return;
    const timer = window.setTimeout(() => {
      setPendingDraft(nextPendingDraft);
      setStatus("idle");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [enabled, key]);

  useEffect(() => {
    if (!key || !enabled || pendingDraft) return;
    if (!shouldSave(value)) {
      if (typeof window !== "undefined") window.localStorage.removeItem(key);
      const idleTimer = window.setTimeout(() => setStatus("idle"), 0);
      return () => window.clearTimeout(idleTimer);
    }

    const dirtyTimer = window.setTimeout(() => {
      setStatus((current) => (current === "restored" ? current : "dirty"));
    }, 0);
    const timer = window.setTimeout(() => {
      setStatus("saving");
      writeDraft(value);
    }, debounceMs);
    return () => {
      window.clearTimeout(dirtyTimer);
      window.clearTimeout(timer);
    };
  }, [debounceMs, enabled, key, pendingDraft, shouldSave, value, writeDraft]);

  useEffect(() => {
    const saveBeforeLeaving = () => {
      writeDraft();
    };
    window.addEventListener("beforeunload", saveBeforeLeaving);
    return () => {
      saveBeforeLeaving();
      window.removeEventListener("beforeunload", saveBeforeLeaving);
    };
  }, [writeDraft]);

  const restoreDraft = useCallback(() => {
    if (!pendingDraft) return;
    onRestore(pendingDraft.value);
    setPendingDraft(null);
    setStatus("restored");
  }, [onRestore, pendingDraft]);

  const discardDraft = useCallback(() => {
    clearDraft();
  }, [clearDraft]);

  return {
    status,
    pendingDraft,
    restoreDraft,
    discardDraft,
    clearDraft,
    saveNow: writeDraft,
  };
}

export function DraftRestoreBanner({
  pendingDraft,
  onRestore,
  onDiscard,
}: {
  pendingDraft: StoredDraft<unknown> | null;
  onRestore: () => void;
  onDiscard: () => void;
}) {
  if (!pendingDraft) return null;

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <div className="font-semibold">You have an unsaved draft. Restore it?</div>
      <div className="mt-1">Saved locally on this device {new Date(pendingDraft.updatedAt).toLocaleString()}.</div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn-primary" onClick={onRestore}>Restore Draft</button>
        <button type="button" className="btn-secondary" onClick={onDiscard}>Discard Draft</button>
      </div>
    </div>
  );
}

export function DraftSaveStatus({ status }: { status: DraftStatus }) {
  if (status === "idle") return null;
  const label =
    status === "dirty"
      ? "Unsaved changes"
      : status === "saving"
        ? "Saving draft..."
        : status === "restored"
          ? "Draft restored"
          : status === "error"
            ? "Draft could not be saved"
            : "Draft saved locally";
  const tone = status === "dirty" || status === "saving"
    ? "border-amber-200 bg-amber-50 text-amber-800"
    : status === "error"
      ? "border-rose-200 bg-rose-50 text-rose-800"
      : "border-emerald-200 bg-emerald-50 text-emerald-800";

  return <div className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${tone}`}>{label}</div>;
}

function collectFormDraft(form: HTMLFormElement): FormDraftValue {
  const controls: FormControlDraft[] = [];
  const files: Record<string, FileDraftMetadata[]> = {};
  const elements = Array.from(form.elements);

  elements.forEach((element) => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return;
    const name = element.name;
    if (!name) return;

    if (element instanceof HTMLInputElement) {
      const type = element.type.toLowerCase();
      if (["button", "submit", "reset", "hidden", "password"].includes(type)) return;
      if (type === "file") {
        const metadata = Array.from(element.files ?? []).map((file) => ({
          name: file.name,
          size: file.size,
          type: file.type,
          lastModified: file.lastModified,
        }));
        if (metadata.length) files[name] = metadata;
        return;
      }
      controls.push({ name, tagName: "input", type, value: element.value, checked: element.checked });
      return;
    }

    if (element instanceof HTMLSelectElement && element.multiple) {
      controls.push({ name, tagName: "select", type: "select-multiple", value: "", multipleValues: Array.from(element.selectedOptions).map((option) => option.value) });
      return;
    }

    controls.push({ name, tagName: element.tagName.toLowerCase(), type: element instanceof HTMLSelectElement ? "select" : "textarea", value: element.value });
  });

  return { controls, files };
}

function restoreFormDraft(form: HTMLFormElement, draft: FormDraftValue) {
  const controlsByName = new Map<string, FormControlDraft[]>();
  draft.controls.forEach((control) => {
    controlsByName.set(control.name, [...(controlsByName.get(control.name) ?? []), control]);
  });

  Array.from(form.elements).forEach((element) => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return;
    if (!element.name) return;
    const queue = controlsByName.get(element.name);
    const control = queue?.shift();
    if (!control) return;

    if (element instanceof HTMLInputElement) {
      const type = element.type.toLowerCase();
      if (type === "file") return;
      if (type === "checkbox" || type === "radio") {
        element.checked = Boolean(control.checked);
      } else {
        element.value = control.value;
      }
    } else if (element instanceof HTMLSelectElement && element.multiple) {
      const values = new Set(control.multipleValues ?? []);
      Array.from(element.options).forEach((option) => {
        option.selected = values.has(option.value);
      });
    } else {
      element.value = control.value;
    }

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function hasFormDraftContent(value: FormDraftValue) {
  return (
    value.controls.some((control) => {
      if (control.type === "checkbox" || control.type === "radio") return Boolean(control.checked);
      if (control.multipleValues) return control.multipleValues.length > 0;
      return control.value.trim().length > 0;
    }) || Object.values(value.files).some((files) => files.length > 0)
  );
}

export function LocalDraftForm({
  action,
  formType,
  draftKeyParts = ["new"],
  children,
  className,
  userId,
  noValidate,
}: {
  action?: (formData: FormData) => void | Promise<void>;
  formType: string;
  draftKeyParts?: Array<string | number | null | undefined>;
  children: ReactNode;
  className?: string;
  userId?: string | null;
  noValidate?: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const draftKey = useDraftKey(formType, draftKeyParts, userId);
  const [snapshot, setSnapshot] = useState<FormDraftValue>({ controls: [], files: {} });
  const [restoredFileNames, setRestoredFileNames] = useState<string[]>([]);
  const draft = useLocalDraft<FormDraftValue>({
    key: draftKey,
    value: snapshot,
    shouldSave: hasFormDraftContent,
    onRestore: (value) => {
      if (formRef.current) restoreFormDraft(formRef.current, value);
      setSnapshot(value);
      setRestoredFileNames(Object.values(value.files).flat().map((file) => file.name));
    },
  });

  const refreshSnapshot = () => {
    if (!formRef.current) return snapshot;
    const nextSnapshot = collectFormDraft(formRef.current);
    setSnapshot(nextSnapshot);
    return nextSnapshot;
  };

  const wrappedAction = action
    ? async (formData: FormData) => {
        const nextSnapshot = refreshSnapshot();
        draft.saveNow(nextSnapshot);
        try {
          await action(formData);
          draft.clearDraft();
        } catch (error) {
          draft.saveNow(nextSnapshot);
          const target = redirectTarget(error);
          if (target && !target.includes("error=")) draft.clearDraft();
          throw error;
        }
      }
    : undefined;

  const handleSubmitCapture = (_event: FormEvent<HTMLFormElement>) => {
    const nextSnapshot = refreshSnapshot();
    draft.saveNow(nextSnapshot);
  };

  return (
    <form
      ref={formRef}
      action={wrappedAction}
      className={className}
      noValidate={noValidate}
      onInput={refreshSnapshot}
      onChange={refreshSnapshot}
      onSubmitCapture={handleSubmitCapture}
    >
      <DraftRestoreBanner pendingDraft={draft.pendingDraft} onRestore={draft.restoreDraft} onDiscard={draft.discardDraft} />
      {restoredFileNames.length ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs font-medium text-amber-900">
          File selections are saved as metadata only. Re-select before saving: {restoredFileNames.join(", ")}
        </div>
      ) : null}
      <DraftSaveStatus status={draft.status} />
      {children}
    </form>
  );
}
