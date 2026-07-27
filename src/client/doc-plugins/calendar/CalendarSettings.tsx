import { useState, useEffect } from 'preact/hooks';
import { MdTextField } from '@/components/ui/md-text-field';
import { PropertySheet } from '../../shared/PropertySheet';
import type { PropertyDef } from '../../shared/PropertySheet';
import { updateDoc } from '../../worker-api';
import { docUrl } from '../../shared/doc-urls';

interface CalendarSettingsProps {
  opened: boolean;
  docId: string | null;
  name: string;
  description: string;
  color: string;
  onClose: () => void;
}

/**
 * Calendar settings bottom sheet (name / color / description) — opened from the
 * title-bar overflow menu (and per-calendar from AllCalendars). Auto-save:
 * fields commit on blur/change; dismissing the sheet is the "done" gesture.
 *
 * Colour is an `inline` property: a swatch in the row's trailing slot rather
 * than a detail pane, since `<input type="color">` opens the OS picker anyway.
 */
export function CalendarSettings({ opened, docId, name, description, color, onClose }: CalendarSettingsProps) {
  const [localName, setLocalName] = useState(name);
  const [localDesc, setLocalDesc] = useState(description);
  const [localColor, setLocalColor] = useState(color);

  useEffect(() => { setLocalName(name); setLocalDesc(description); setLocalColor(color); }, [name, description, color]);

  const commit = (overrides: Partial<{ name: string; description: string; color: string }> = {}) => {
    if (!docId) return;
    const effName = overrides.name ?? localName;
    const effDesc = overrides.description ?? localDesc;
    const effColor = overrides.color ?? localColor;
    updateDoc(docId, (d: any, name: string, desc: string, color: string) => {
      d.name = name.trim() || 'Untitled';
      if (desc.trim()) d.description = desc.trim();
      else delete d.description;
      d.color = color;
    }, effName, effDesc, effColor);
  };

  const properties: PropertyDef[] = [
    {
      id: 'cs-name',
      label: 'Name',
      icon: 'label',
      summary: () => localName,
      render: ({ back }) => (
        <MdTextField
          label="Name"
          data-testid="cs-name"
          value={localName}
          onInput={setLocalName}
          onCommit={v => commit({ name: v })}
          onEnter={v => { commit({ name: v }); back(); }}
        />
      ),
    },
    {
      id: 'cs-color',
      label: 'Color',
      icon: 'palette',
      summary: () => localColor,
      inline: () => (
        <input
          type="color"
          data-testid="cs-color"
          aria-label="Color"
          value={localColor}
          onInput={(e: any) => setLocalColor(e.currentTarget.value)}
          onChange={(e: any) => commit({ color: e.currentTarget.value })}
          style={{ width: 28, height: 28, padding: 0, border: 'none', borderRadius: 4, cursor: 'pointer', background: 'none' }}
        />
      ),
    },
    {
      id: 'cs-desc',
      label: 'Description',
      icon: 'notes',
      summary: () => localDesc,
      render: () => (
        <MdTextField
          label="Description"
          type="textarea"
          rows={4}
          data-testid="cs-desc"
          value={localDesc}
          placeholder="Add a description..."
          onInput={setLocalDesc}
          onCommit={v => commit({ description: v })}
        />
      ),
    },
  ];

  return (
    <PropertySheet
      open={opened}
      title="Calendar Settings"
      data-testid="calendar-settings"
      properties={properties}
      onClose={onClose}
      flushOnClose
      footer={docId ? (
        <a href={docUrl(docId)} className="block mt-3 text-xs text-muted-foreground hover:underline">
          Open individual calendar view
        </a>
      ) : undefined}
    />
  );
}
