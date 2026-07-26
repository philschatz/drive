import { useState, useEffect } from 'preact/hooks';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
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

  return (
    <Sheet open={opened} onOpenChange={(open: boolean) => { if (!open) onClose(); }}>
      <SheetContent side="bottom" className="max-h-[85vh]">
        <SheetHeader>
          <SheetTitle>Calendar Settings</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-3 mt-4">
          <div>
            <Label>Name</Label>
            <Input
              value={localName}
              onInput={(e: any) => setLocalName(e.currentTarget.value)}
              onBlur={(e: any) => commit({ name: e.currentTarget.value })}
              onKeyDown={(e: any) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            />
          </div>
          <div>
            <Label>Color</Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={localColor}
                onInput={(e: any) => setLocalColor(e.currentTarget.value)}
                onChange={(e: any) => commit({ color: e.currentTarget.value })}
                style={{ width: 28, height: 28, padding: 0, border: 'none', borderRadius: 4, cursor: 'pointer', background: 'none' }}
              />
              <span className="text-sm text-muted-foreground">{localColor}</span>
            </div>
          </div>
          <div>
            <Label>Description</Label>
            <Textarea
              value={localDesc}
              onInput={(e: any) => setLocalDesc(e.currentTarget.value)}
              onBlur={(e: any) => commit({ description: e.currentTarget.value })}
              placeholder="Add a description..."
              rows={3}
            />
          </div>
          {docId && (
            <a href={docUrl(docId)} className="text-xs text-muted-foreground hover:underline">
              Open individual calendar view
            </a>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
