import { useState, useRef, useEffect } from 'preact/hooks';
import { StatusDot } from '../common/presence';
import type { DeviceStatus } from '../common/use-devices';

/**
 * Inline text-input editor shared by EditableDeviceName and EditableUserName.
 *
 * Owns the draft state, the save-on-blur/Enter behavior, and the subscription
 * that keeps the field in sync with an async-populated name cache without
 * clobbering in-progress input. Each caller binds it to one name store by
 * passing that store's `get`/`set`/`subscribe` functions (stable module-level
 * refs, so the effect deps don't churn) plus a pre-computed placeholder.
 *
 * The cache is populated asynchronously — seeded on worker startup, and updated
 * when a name is learned during a device link / QR contact exchange, often AFTER
 * this component first mounts — so we both replay once on mount and subscribe.
 * The `editingRef` guard suppresses a cache→draft sync while the user is
 * actively editing, so a late push can't overwrite what they're typing.
 *
 * When `status` is passed, a leading presence dot (filled = direct/P2P, hollow
 * ring = via relay, gray = offline) is shown before the field.
 */
export function EditableName({ agentId, get, set, subscribe, placeholder, title, suffix, status }: {
  agentId: string;
  get: (agentId: string) => string | undefined;
  set: (agentId: string, name: string) => Promise<void>;
  subscribe: (fn: () => void) => () => void;
  placeholder: string;
  title?: string;
  suffix?: any;
  /** Live connectivity for this name's device/user; omit to hide the dot. */
  status?: DeviceStatus;
}) {
  const [draft, setDraft] = useState(() => get(agentId) || '');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const editingRef = useRef(false);

  useEffect(() => {
    const sync = () => {
      if (editingRef.current) return;
      const saved = get(agentId) || '';
      if (saved !== draftRef.current) setDraft(saved);
    };
    sync(); // cache may have populated between initial state and mount
    return subscribe(sync);
  }, [agentId, get, set, subscribe]);

  const save = () => {
    editingRef.current = false;
    set(agentId, draftRef.current).catch(err =>
      console.error('[EditableName] Failed to save name:', err)
    );
  };

  return (
    <span className="flex items-center flex-1 gap-1">
      {status && (
        <StatusDot online={status.online} direct={status.transport === 'direct'} label={draft || placeholder} />
      )}
      <input
        className="text-sm flex-1 bg-transparent outline-none px-0 min-w-0"
        value={draft}
        onFocus={() => { editingRef.current = true; }}
        onInput={(e: any) => setDraft(e.currentTarget.value)}
        onBlur={save}
        onKeyDown={(e: any) => {
          if (e.key === 'Enter') { save(); e.currentTarget.blur(); }
        }}
        placeholder={placeholder}
        title={title}
      />
      {suffix}
    </span>
  );
}
