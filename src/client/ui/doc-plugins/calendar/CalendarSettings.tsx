import { useState, useEffect } from 'preact/hooks';
import { MdTextField } from '@/components/ui/md-text-field';
import { PropertySheet } from '../../common/PropertySheet';
import type { PropertyDef } from '../../common/PropertySheet';
import { FieldEditor } from '../../common/FieldEditor';
import { updateDoc } from '../../worker-api';
import { docUrl } from '../../common/doc-urls';

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
 * title-bar overflow menu (and per-calendar from AllCalendars). Name and
 * description commit on their pane's Save; the colour swatch, being inline on its
 * row, commits on change.
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
      transactional: true,
      render: ({ back }) => (
        <FieldEditor
          data-testid="cs-name"
          value={localName}
          onCancel={back}
          onSave={v => { setLocalName(v); commit({ name: v }); back(); }}
        >
          {({ value, onInput, save }) => (
            <MdTextField
              label="Name"
              data-testid="cs-name"
              value={value}
              onInput={onInput}
              onEnter={save}
            />
          )}
        </FieldEditor>
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
      transactional: true,
      render: ({ back }) => (
        <FieldEditor
          data-testid="cs-desc"
          value={localDesc}
          onCancel={back}
          onSave={v => { setLocalDesc(v); commit({ description: v }); back(); }}
        >
          {({ value, onInput }) => (
            <MdTextField
              label="Description"
              type="textarea"
              rows={4}
              data-testid="cs-desc"
              value={value}
              placeholder="Add a description..."
              onInput={onInput}
            />
          )}
        </FieldEditor>
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
      // No flushOnClose: name/description are transactional, and the colour swatch
      // commits on change.
      footer={docId ? (
        <a href={docUrl(docId)} className="block mt-3 text-xs text-muted-foreground hover:underline">
          Open individual calendar view
        </a>
      ) : undefined}
    />
  );
}
