/**
 * A read-only identifier as a tappable Material row: label as the headline, the
 * value as monospace supporting text, and a copy glyph in the trailing slot.
 *
 * It replaces the `<code onClick={…clipboard…}>` chips the old Settings used for
 * keyhive ids. Those truncated the value to 16 characters, were not focusable (so
 * unreachable by keyboard), and gave no sign that the copy had happened. A row is
 * focusable with Enter/Space, copies the *full* value regardless of what is
 * displayed, and confirms with a snackbar.
 */
import { showToast, showError } from '@/components/ui/toast';

export function CopyRow({ icon, label, value, empty, 'data-testid': testId }: {
  icon: string;
  label: string;
  /** Copied verbatim on tap. Falsy renders an inert row showing `empty`. */
  value: string | null | undefined;
  /** Supporting text when there is no value: 'Not created yet', '(none)'. */
  empty?: string;
  'data-testid': string;
}) {
  if (!value) {
    return (
      <md-list-item type="text" data-testid={testId}>
        <md-icon slot="start">{icon}</md-icon>
        <div slot="headline">{label}</div>
        {empty && <div slot="supporting-text" className="opacity-60">{empty}</div>}
      </md-list-item>
    );
  }

  const copy = () => {
    if (!navigator.clipboard) {
      showError('Clipboard unavailable');
      return;
    }
    navigator.clipboard.writeText(value).then(
      () => showToast(`${label} copied`),
      () => showError(`Could not copy ${label.toLowerCase()}`),
    );
  };

  return (
    // `title` gives the desktop hover the whole value; the row itself stays one
    // line so a page of ids doesn't turn into a wall of wrapped base64.
    <md-list-item type="button" data-testid={testId} title={value} onClick={copy}>
      <md-icon slot="start">{icon}</md-icon>
      <div slot="headline">{label}</div>
      <div slot="supporting-text" className="font-mono truncate">{value}</div>
      <md-icon slot="end" aria-hidden="true">content_copy</md-icon>
    </md-list-item>
  );
}
