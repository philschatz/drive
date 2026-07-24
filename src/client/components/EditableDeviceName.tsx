import { useState, useRef, useEffect } from 'preact/hooks';
import { getDeviceName, setDeviceName } from '../device-names';
import { onDeviceNamesUpdated } from '../worker-api';
import { generateDefaultDeviceName } from '../lib/device-name';

/**
 * Inline editor for a device's name (each row in DeviceList). Bound to the
 * device-name store; any device can be relabelled locally (a rename of a remote
 * device is a local label — like a contact name — and does not propagate).
 *
 * Placeholder: for THIS device (`isMe`) a blank field shows the generated
 * default (📱/💻 + browser) it will be called until overridden. For a remote
 * device we can't sniff its browser, so it falls back to the truncated id.
 */
export function EditableDeviceName({ agentId, isMe, suffix }: { agentId: string; isMe?: boolean; suffix?: any }) {
  const [draft, setDraft] = useState(() => getDeviceName(agentId) || '');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Suppress cache→draft sync while the user is actively editing this field, so
  // a late worker push (startup seed / a name learned via rendezvous) can't
  // clobber in-progress input.
  const editingRef = useRef(false);

  // Keep the field in sync with the store: the main-thread cache is populated
  // asynchronously (seeded on worker startup, and updated when a peer's name is
  // learned during a device link), often AFTER this component first mounts.
  useEffect(() => {
    const sync = () => {
      if (editingRef.current) return;
      const saved = getDeviceName(agentId) || '';
      if (saved !== draftRef.current) setDraft(saved);
    };
    sync(); // cache may have populated between initial state and mount
    return onDeviceNamesUpdated(sync);
  }, [agentId]);

  // Stable placeholder: computing it once on mount avoids re-sniffing every render.
  const placeholderRef = useRef<string>();
  if (!placeholderRef.current) {
    placeholderRef.current = isMe ? generateDefaultDeviceName() : `${agentId.slice(0, 16)}…`;
  }

  const save = () => {
    editingRef.current = false;
    setDeviceName(agentId, draftRef.current).catch(err =>
      console.error('[EditableDeviceName] Failed to save device name:', err)
    );
  };

  return (
    <span className="flex items-center flex-1 gap-1">
      <input
        className="text-sm flex-1 bg-transparent outline-none px-0 min-w-0"
        value={draft}
        onFocus={() => { editingRef.current = true; }}
        onInput={(e: any) => setDraft(e.currentTarget.value)}
        onBlur={save}
        onKeyDown={(e: any) => {
          if (e.key === 'Enter') { save(); e.currentTarget.blur(); }
        }}
        placeholder={placeholderRef.current}
        title={agentId}
      />
      {suffix}
    </span>
  );
}
