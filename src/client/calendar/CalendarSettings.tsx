import { useState, useEffect } from 'preact/hooks';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { updateDoc } from '../worker-api';

interface CalendarSettingsProps {
  opened: boolean;
  docId: string | null;
  name: string;
  description: string;
  color: string;
  onClose: () => void;
}

export function CalendarSettings({ opened, docId, name, description, color, onClose }: CalendarSettingsProps) {
  const [localName, setLocalName] = useState(name);
  const [localDesc, setLocalDesc] = useState(description);
  const [localColor, setLocalColor] = useState(color);

  useEffect(() => { setLocalName(name); setLocalDesc(description); setLocalColor(color); }, [name, description, color]);

  const handleSave = () => {
    if (!docId) return;
    updateDoc(docId, (d: any, localName: string, localDesc: string, localColor: string) => {
      d.name = localName.trim() || 'Untitled';
      const desc = localDesc.trim();
      if (desc) d.description = desc;
      else delete d.description;
      d.color = localColor;
    }, localName, localDesc, localColor);
    onClose();
  };

  return (
    <Sheet open={opened} onOpenChange={(open: boolean) => { if (!open) onClose(); }}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Calendar Settings</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-3 mt-4">
          <div>
            <Label>Name</Label>
            <Input value={localName} onInput={(e: any) => setLocalName(e.currentTarget.value)} />
          </div>
          <div>
            <Label>Color</Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={localColor}
                onInput={(e: any) => setLocalColor(e.currentTarget.value)}
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
              placeholder="Add a description..."
              rows={3}
            />
          </div>
          <div className="flex items-center gap-2 mt-4">
            <Button onClick={handleSave}>Save</Button>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
          </div>
          {docId && (
            <a href={`#/calendars/${docId}`} className="text-xs text-muted-foreground hover:underline">
              Open individual calendar view
            </a>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
