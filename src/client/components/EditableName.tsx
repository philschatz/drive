import { useState, useRef } from 'react';
import { getContactName, setContactName } from '../contact-names';

export function EditableName({ agentId, suffix }: { agentId: string; suffix?: any }) {
  const saved = getContactName(agentId);
  const [draft, setDraft] = useState(saved || '');
  // Sync draft when the cache populates after mount (e.g. worker push arrives late)
  if (saved && !draft) setDraft(saved);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const save = () => {
    setContactName(agentId, draftRef.current).catch(err =>
      console.error('[EditableName] Failed to save contact name:', err)
    );
  };

  return (
    <span className="flex items-center flex-1 gap-1">
      <input
        className="text-sm flex-1 bg-transparent outline-none px-0 min-w-0"
        value={draft}
        onInput={(e: any) => setDraft(e.currentTarget.value)}
        onBlur={save}
        onKeyDown={(e: any) => {
          if (e.key === 'Enter') { save(); e.currentTarget.blur(); }
        }}
        placeholder={agentId.slice(0, 12) + '…'}
        title={agentId}
      />
      {suffix}
    </span>
  );
}
