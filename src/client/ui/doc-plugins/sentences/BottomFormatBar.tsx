/**
 * Edit-mode bottom toolbar — DataGrid's BottomEditorBar styling (40px circular
 * state-layer buttons, keyboard-inset aware) applied to text formatting. All
 * buttons act on the editor's current selection through its imperative API and
 * swallow pointerdown so the contenteditable never loses focus.
 */
import { useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { RichTextEditorApi, SelectionState } from './RichTextEditor';
import type { BlockType } from './blocks';

function BarButton({
  icon,
  label,
  active,
  disabled,
  onAction,
}: {
  icon: string;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onAction: () => void;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      disabled={disabled}
      data-testid={`fmt-${icon}`}
      // Keep focus (and so the selection) in the contenteditable.
      onPointerDown={(e: PointerEvent) => e.preventDefault()}
      onMouseDown={(e: MouseEvent) => e.preventDefault()}
      onClick={onAction}
      className={
        'inline-flex items-center justify-center h-10 w-10 rounded-full state-layer shrink-0 disabled:opacity-30' +
        (active ? ' bg-secondary-container text-on-secondary-container' : '')
      }
    >
      <span className="material-symbols-outlined" style={{ fontSize: 22 }}>{icon}</span>
    </button>
  );
}

const BLOCK_STYLES: { type: BlockType; attrs?: Record<string, unknown>; label: string; icon: string }[] = [
  { type: 'paragraph', label: 'Paragraph', icon: 'notes' },
  { type: 'heading', attrs: { level: 1 }, label: 'Heading 1', icon: 'format_h1' },
  { type: 'heading', attrs: { level: 2 }, label: 'Heading 2', icon: 'format_h2' },
  { type: 'heading', attrs: { level: 3 }, label: 'Heading 3', icon: 'format_h3' },
  { type: 'blockquote', label: 'Quote', icon: 'format_quote' },
];

export function BottomFormatBar({
  state,
  apiRef,
  keyboardInset,
}: {
  state: SelectionState | null;
  apiRef: RefObject<RichTextEditorApi | null>;
  /** visualViewport keyboard inset (iOS), from useKeyboardInset. */
  keyboardInset: number;
}) {
  const [styleOpen, setStyleOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState('');
  const api = () => apiRef.current;

  const isStyleActive = (s: typeof BLOCK_STYLES[number]) =>
    s.type === state?.blockType &&
    (s.type !== 'heading' || Number(s.attrs?.level) === state?.headingLevel);
  const currentStyle = BLOCK_STYLES.find(isStyleActive);

  const hasRange = !!state && state.to > state.from;

  return (
    <>
      <div
        className="fixed left-0 right-0 z-20 bg-page flex items-center gap-0.5 px-1 min-h-14 overflow-x-auto"
        style={{
          bottom: keyboardInset,
          borderTop: '1px solid var(--md-sys-color-outline-variant)',
          paddingBottom: keyboardInset > 0 ? 0 : 'env(safe-area-inset-bottom)',
        }}
        data-testid="format-bar"
      >
        <BarButton
          icon="format_bold"
          label="Bold"
          active={!!state?.marks.strong}
          onAction={() => api()?.toggleMark('strong')}
        />
        <BarButton
          icon="format_italic"
          label="Italic"
          active={!!state?.marks.em}
          onAction={() => api()?.toggleMark('em')}
        />
        <BarButton
          icon="link"
          label="Link"
          active={!!state?.linkHref}
          disabled={!hasRange && !state?.linkHref}
          onAction={() => {
            setLinkDraft(state?.linkHref ?? '');
            setLinkOpen(true);
          }}
        />
        <span className="w-px h-6 mx-1 shrink-0" style={{ background: 'var(--md-sys-color-outline-variant)' }} />
        <BarButton
          icon={currentStyle?.icon ?? 'notes'}
          label="Text style"
          active={!!state && state.blockType !== 'paragraph' && !state.inList}
          onAction={() => setStyleOpen(true)}
        />
        <BarButton
          icon="format_list_bulleted"
          label="Bulleted list"
          active={state?.blockType === 'unordered-list-item'}
          onAction={() => api()?.toggleList('unordered-list-item')}
        />
        <BarButton
          icon="format_list_numbered"
          label="Numbered list"
          active={state?.blockType === 'ordered-list-item'}
          onAction={() => api()?.toggleList('ordered-list-item')}
        />
        <BarButton
          icon="format_indent_decrease"
          label="Decrease indent"
          disabled={!state?.inList}
          onAction={() => api()?.outdent()}
        />
        <BarButton
          icon="format_indent_increase"
          label="Increase indent"
          disabled={!state?.inList}
          onAction={() => api()?.indent()}
        />
        <span className="w-px h-6 mx-1 shrink-0" style={{ background: 'var(--md-sys-color-outline-variant)' }} />
        <BarButton
          icon="horizontal_rule"
          label="Insert divider"
          onAction={() => api()?.insertDivider()}
        />
      </div>

      {/* Text style sheet */}
      <Sheet open={styleOpen} onOpenChange={setStyleOpen}>
        <SheetContent side="bottom" className="max-h-[70vh]">
          <SheetHeader>
            <SheetTitle>Text style</SheetTitle>
          </SheetHeader>
          <md-list style={{ background: 'transparent' }} data-testid="style-list">
            {BLOCK_STYLES.map(s => (
              <md-list-item
                key={s.label}
                type="button"
                onClick={() => {
                  api()?.setBlockType(s.type, s.attrs);
                  setStyleOpen(false);
                }}
              >
                <span slot="start" className="material-symbols-outlined">{s.icon}</span>
                <div slot="headline">{s.label}</div>
                {isStyleActive(s) && (
                  <span slot="end" className="material-symbols-outlined">check</span>
                )}
              </md-list-item>
            ))}
          </md-list>
        </SheetContent>
      </Sheet>

      {/* Link sheet */}
      <Sheet open={linkOpen} onOpenChange={setLinkOpen}>
        <SheetContent side="bottom">
          <SheetHeader>
            <SheetTitle>Link</SheetTitle>
          </SheetHeader>
          <form
            className="flex flex-col gap-3 mt-3"
            onSubmit={(e: Event) => {
              e.preventDefault();
              const href = linkDraft.trim();
              api()?.setLink(href ? href : null);
              setLinkOpen(false);
            }}
          >
            <input
              type="url"
              inputMode="url"
              placeholder="https://…"
              data-testid="link-input"
              className="border rounded-md px-3 py-2 bg-transparent outline-none"
              style={{ borderColor: 'var(--md-sys-color-outline-variant)' }}
              value={linkDraft}
              onInput={(e: any) => setLinkDraft(e.currentTarget.value)}
            />
            {/* MD3 dialog actions: text buttons for the secondary choices, one
                filled button for the confirming action, all 40px pills on the
                trailing edge. The destructive one is pushed to the leading edge
                so Remove is never the button next to Apply. */}
            <div className="flex items-center gap-2 justify-end mt-1">
              {state?.linkHref && (
                <>
                  <button
                    type="button"
                    className="md-label-large px-3 h-10 rounded-full state-layer text-error mr-auto"
                    onClick={() => { api()?.setLink(null); setLinkOpen(false); }}
                  >
                    Remove
                  </button>
                  {/* The document is always editable, so a click in the text
                      places the caret rather than following the link — this is
                      how an editor opens one (and it works on a phone, which a
                      modifier-click does not). */}
                  <button
                    type="button"
                    data-testid="link-open"
                    className="md-label-large px-3 h-10 rounded-full state-layer text-primary"
                    onClick={() => {
                      window.open(state.linkHref!, '_blank', 'noopener');
                      setLinkOpen(false);
                    }}
                  >
                    Open
                  </button>
                </>
              )}
              <button
                type="submit"
                className="md-label-large px-6 h-10 rounded-full bg-primary text-on-primary state-layer"
              >
                Apply
              </button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}
