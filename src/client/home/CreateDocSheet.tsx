/**
 * Create bottom sheet — opened by Home's FAB. Lists the registered doc-type
 * plugins plus the import options (.ics / .xlsx / .json). Replaces the old
 * "New" dropdown menu.
 */
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { DOC_PLUGINS, type DocTypePlugin } from '@/doc-plugins';

const IMPORTS = [
  { kind: 'ics' as const, icon: 'date_range', label: 'Import .ics' },
  { kind: 'xlsx' as const, icon: 'grid_on', label: 'Import .xlsx' },
  { kind: 'json' as const, icon: 'code', label: 'Import .json' },
];

export type ImportKind = (typeof IMPORTS)[number]['kind'];

interface CreateDocSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (plugin: DocTypePlugin) => void;
  onImport: (kind: ImportKind) => void;
}

export function CreateDocSheet({ open, onOpenChange, onCreate, onImport }: CreateDocSheetProps) {
  // Close the sheet first so the action's own UI (navigation, file picker)
  // isn't stacked under it.
  const pick = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] p-4">
        <SheetHeader>
          <SheetTitle>Create</SheetTitle>
        </SheetHeader>
        <md-list style={{ background: 'transparent' }} className="mt-2" data-testid="create-doc-sheet">
          {DOC_PLUGINS.map(p => (
            <md-list-item key={p.type} type="button" onClick={pick(() => onCreate(p))}>
              <md-icon slot="start">{p.icon}</md-icon>
              <div slot="headline">{p.createLabel}</div>
            </md-list-item>
          ))}
          <md-divider role="separator" />
          {IMPORTS.map(imp => (
            <md-list-item key={imp.kind} type="button" onClick={pick(() => onImport(imp.kind))}>
              <md-icon slot="start">{imp.icon}</md-icon>
              <div slot="headline">{imp.label}</div>
            </md-list-item>
          ))}
        </md-list>
      </SheetContent>
    </Sheet>
  );
}
