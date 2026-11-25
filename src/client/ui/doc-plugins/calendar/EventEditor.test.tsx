import 'temporal-polyfill/global';
import { render, screen, fireEvent, act } from '@testing-library/preact';

// The event editor on the in-memory worker-api mock, which records the presence
// this client announces. The Calendar views themselves need schedule-x, which
// jsdom cannot run, so the editor is driven standalone — it is the same
// component both of them mount.
jest.mock('../../worker-api');
import * as api from '../../worker-api';
import { EventEditor } from './EventEditor';
import type { CalendarEvent } from '../../../../shared/schemas/calendar';

const mock = api as any;
it('uses the manual worker-api mock', () => expect(mock.__isMock).toBe(true));

const DOC = 'doc-calendar';
const ITEM = ['events', 'e1'];
const weekly: CalendarEvent = {
  '@type': 'Event', title: 'Standup', start: '2026-07-01T09:00:00', duration: 'PT30M', timeZone: null,
  recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly', count: 5 },
} as CalendarEvent;

const noop = () => {};
const renderEditor = () => render(
  <EventEditor
    uid="e1" event={weekly} masterEvent={weekly} recurrenceDate={null} isNew={false} opened
    onSave={noop} onSaveOverride={noop} onDelete={noop} onDeleteOccurrence={noop} onClose={noop} onEditAll={noop}
    presence={{ docId: DOC, path: ITEM }}
  />,
);
const focused = () => mock.__presenceSent(DOC)?.focusedField;
const byId = (id: string) => document.getElementById(id)!;
/** Move focus into a control and back out, as tabbing through it does. */
const visit = (el: Element) => { fireEvent.focusIn(el); fireEvent.focusOut(el); };

// The sheet announces the open pane, so every control inside one is covered —
// the interval, the count and the end date used to announce nothing.
describe('EventEditor presence', () => {
  beforeEach(() => { mock.__reset(); });

  it('announces the event while the list shows', () => {
    renderEditor();
    expect(mock.__presenceSent(DOC)).toEqual({ viewing: true, focusedField: ITEM });
  });

  it('the When pane announces the start, whichever of its controls has focus', () => {
    renderEditor();
    fireEvent.click(screen.getByTestId('ed-when-row'));
    expect(focused()).toEqual([...ITEM, 'start']);
    visit(byId('ed-duration'));
    expect(focused()).toEqual([...ITEM, 'start']);
  });

  it('the Repeat pane stays on the rule through the interval, the count and the end date', () => {
    renderEditor();
    fireEvent.click(screen.getByTestId('ed-repeat-row'));
    expect(focused()).toEqual([...ITEM, 'recurrenceRule']);
    visit(byId('ed-interval'));
    expect(focused()).toEqual([...ITEM, 'recurrenceRule']);
    visit(byId('ed-count'));
    expect(focused()).toEqual([...ITEM, 'recurrenceRule']);
    fireEvent.input(byId('ed-ends'), { target: { value: 'until' } });
    visit(byId('ed-until'));
    expect(focused()).toEqual([...ITEM, 'recurrenceRule']);
  });

  it('lights When for a peer on the start or the duration, and Repeat for one on the rule', () => {
    renderEditor();
    const dotIn = (row: string) => screen.getByTestId(row).querySelector('[data-testid="peer-dot"]');
    const peerOn = (prop: string) => act(() => mock.__setPresence(DOC, {
      'alice-drive': { peerId: 'alice-drive', value: { viewing: true, focusedField: [...ITEM, prop], userGroupId: 'alice' } },
    }));
    peerOn('duration');
    expect(dotIn('ed-when-row')).toBeTruthy();
    expect(dotIn('ed-repeat-row')).toBeNull();
    peerOn('start');
    expect(dotIn('ed-when-row')).toBeTruthy();
    peerOn('recurrenceRule');
    expect(dotIn('ed-repeat-row')).toBeTruthy();
    expect(dotIn('ed-when-row')).toBeNull();
  });

  it('a grouped pane keeps its heading', () => {
    renderEditor();
    fireEvent.click(screen.getByTestId('ed-repeat-row'));
    expect(screen.getByTestId('event-editor-detail').querySelector('.md-label-large')?.textContent).toBe('Repeat');
  });
});
