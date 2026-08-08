import 'temporal-polyfill/global';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/preact';

// Driven through the real Counters container so the assertions cover the whole
// path an edit takes — pane → change → saveCounter → document. md-* elements are
// unregistered under jsdom, so MdSelect is a native <select> and MdTextField a
// native <input>, both drivable with fireEvent.input.
jest.mock('../../worker-api');
import * as api from '../../worker-api';
import { Counters } from './Counters';

const mock = api as any;
const DOC = 'doc-counter-editor';
const rowOf = (title: string) => screen.getByText(title).closest('[data-status]') as HTMLElement;
const eventsOf = () => mock.__getDoc(DOC).events as Record<string, any>;
const only = () => Object.values(eventsOf())[0] as any;

const habit = (extra: Record<string, any> = {}) => ({
  '@type': 'Event', title: 'Stretch',
  recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily' },
  ...extra,
});

/**
 * Open the editor on the seeded habit and navigate into one property pane.
 * A tap on the row records a completion — the editor is the row's SECONDARY
 * surface, reached by holding it (right-click is the same gesture, and the one
 * jsdom can dispatch synchronously).
 */
async function openPane(paneId: string, title = 'Stretch') {
  render(<Counters docId={DOC} />);
  await waitFor(() => expect(screen.getByText(title)).toBeTruthy());
  fireEvent.contextMenu(rowOf(title));
  fireEvent.click(screen.getByTestId(`${paneId}-row`));
}

describe('CounterEditor', () => {
  let writes: jest.SpyInstance;
  beforeEach(() => {
    mock.__reset();
    writes = jest.spyOn(api, 'updateDoc');
  });
  afterEach(() => writes.mockRestore());

  describe('the Repeat pane', () => {
    it('changes the whole rule once, on Save', async () => {
      mock.__setDoc(DOC, { '@type': 'Calendar+Counters', name: 'C', events: { e1: habit() } });
      await openPane('ced-repeat');

      fireEvent.input(screen.getByTestId('ced-freq'), { target: { value: 'weekly' } });
      const days = within(screen.getByTestId('ced-bydays')).getAllByRole('checkbox');
      fireEvent.click(days[0]); // Mon
      fireEvent.click(days[2]); // Wed
      fireEvent.click(days[4]); // Fri

      // Four interactions, nothing written yet.
      expect(writes).not.toHaveBeenCalled();
      expect(eventsOf().e1.recurrenceRule.frequency).toBe('daily');

      fireEvent.click(screen.getByTestId('ced-repeat-save'));
      expect(writes).toHaveBeenCalledTimes(1);
      expect(eventsOf().e1.recurrenceRule).toMatchObject({
        frequency: 'weekly',
        byDay: [{ '@type': 'NDay', day: 'mo' }, { '@type': 'NDay', day: 'we' }, { '@type': 'NDay', day: 'fr' }],
      });
      // Back on the list, showing the new rule.
      expect(screen.getByTestId('ced-repeat-row').textContent).toContain('weekly on mo, we, fr');
    });

    it('discards the draft on Cancel and on Escape', async () => {
      mock.__setDoc(DOC, { '@type': 'Calendar+Counters', name: 'C', events: { e1: habit() } });
      await openPane('ced-repeat');
      fireEvent.input(screen.getByTestId('ced-freq'), { target: { value: 'monthly' } });
      fireEvent.click(screen.getByTestId('ced-repeat-cancel'));
      expect(writes).not.toHaveBeenCalled();
      expect(screen.getByTestId('ced-repeat-row').textContent).toContain('daily');

      fireEvent.click(screen.getByTestId('ced-repeat-row'));
      fireEvent.input(screen.getByTestId('ced-freq'), { target: { value: 'monthly' } });
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(writes).not.toHaveBeenCalled();
      expect(screen.getByTestId('ced-repeat-row').textContent).toContain('daily');
    });

    it('leaves the interval out of the rule while the Every field is blank', async () => {
      mock.__setDoc(DOC, { '@type': 'Calendar+Counters', name: 'C', events: { e1: habit({ recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily', interval: 3 } }) } });
      await openPane('ced-repeat');

      const every = screen.getByTestId('ced-interval') as HTMLInputElement;
      expect(every.value).toBe('3');
      fireEvent.input(every, { target: { value: '' } }); // clearing must stick, not snap back to 1
      expect((screen.getByTestId('ced-interval') as HTMLInputElement).value).toBe('');
      fireEvent.click(screen.getByTestId('ced-repeat-save'));
      expect(eventsOf().e1.recurrenceRule.interval).toBeUndefined();
      expect(screen.getByTestId('ced-repeat-row').textContent).toContain('daily');

      fireEvent.click(screen.getByTestId('ced-repeat-row'));
      fireEvent.input(screen.getByTestId('ced-interval'), { target: { value: '2' } });
      fireEvent.click(screen.getByTestId('ced-repeat-save'));
      expect(eventsOf().e1.recurrenceRule.interval).toBe(2);
    });
  });

  describe('the window', () => {
    it('edits start/end times and stores a duration', async () => {
      mock.__setDoc(DOC, { '@type': 'Calendar+Counters', name: 'C', events: { e1: habit() } });
      await openPane('ced-time');
      fireEvent.input(screen.getByTestId('ced-time'), { target: { value: '08:00' } });
      fireEvent.click(screen.getByTestId('ced-time-save'));
      expect(only().startTime).toBe('08:00:00');

      fireEvent.click(screen.getByTestId('ced-end-row'));
      fireEvent.input(screen.getByTestId('ced-end'), { target: { value: '09:30' } });
      fireEvent.click(screen.getByTestId('ced-end-save'));
      expect(only().duration).toBe('PT1H30M');
      // The row shows the end time back, not the stored duration.
      expect(screen.getByTestId('ced-end-row').textContent).toContain('09:30');
    });

    it('shifting the start time keeps the window length', async () => {
      mock.__setDoc(DOC, { '@type': 'Calendar+Counters', name: 'C', events: { e1: habit({ startTime: '08:00:00', duration: 'PT1H' }) } });
      await openPane('ced-time');
      fireEvent.input(screen.getByTestId('ced-time'), { target: { value: '10:00' } });
      fireEvent.click(screen.getByTestId('ced-time-save'));
      expect(only()).toMatchObject({ startTime: '10:00:00', duration: 'PT1H' });
      expect(screen.getByTestId('ced-end-row').textContent).toContain('11:00');
    });
  });

  describe('the reward', () => {
    it('stores goal and text in the description, and counts down on the row', async () => {
      const today = Temporal.Now.plainDateISO().toString();
      const yesterday = Temporal.Now.plainDateISO().subtract({ days: 1 }).toString();
      mock.__setDoc(DOC, {
        '@type': 'Calendar+Counters', name: 'C',
        events: { e1: habit({ completions: { [`${yesterday}T09:00:00`]: '', [`${today}T09:00:00`]: '' } }) },
      });
      await openPane('ced-reward');

      fireEvent.input(screen.getByTestId('ced-reward-goal'), { target: { value: '5' } });
      fireEvent.input(screen.getByTestId('ced-reward-text'), { target: { value: 'Ice cream' } });
      expect(writes).not.toHaveBeenCalled(); // one write for the pair
      fireEvent.click(screen.getByTestId('ced-reward-save'));
      expect(writes).toHaveBeenCalledTimes(1);
      expect(only().description).toBe('5: Ice cream');

      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      // A 2-day streak against a goal of 5 → three more to go.
      const badge = within(rowOf('Stretch')).getByTestId('counter-reward');
      expect(badge.textContent).toContain('3');
      expect(badge.getAttribute('title')).toBe('3 more in a row to unlock: Ice cream');
    });

    it('keeps a description with no goal as a plain note', async () => {
      mock.__setDoc(DOC, { '@type': 'Calendar+Counters', name: 'C', events: { e1: habit({ description: 'after breakfast' }) } });
      await openPane('ced-reward');
      expect((screen.getByTestId('ced-reward-goal') as HTMLInputElement).value).toBe('');
      expect((screen.getByTestId('ced-reward-text') as HTMLInputElement).value).toBe('after breakfast');
      fireEvent.input(screen.getByTestId('ced-reward-text'), { target: { value: 'after lunch' } });
      fireEvent.click(screen.getByTestId('ced-reward-save'));
      expect(only().description).toBe('after lunch');
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(within(rowOf('Stretch')).queryByTestId('counter-reward')).toBeNull();
    });
  });

  describe('creating', () => {
    it('Enter chains another counter, Save lands on the property list to finish this one', async () => {
      mock.__setDoc(DOC, { '@type': 'Calendar+Counters', name: 'C', events: {} });
      render(<Counters docId={DOC} />);
      await waitFor(() => expect(document.querySelector('md-fab')).toBeTruthy());

      // Enter: saves and reopens on a blank one (rapid entry).
      fireEvent.click(document.querySelector('md-fab')!);
      fireEvent.input(screen.getByTestId('ced-title'), { target: { value: 'Floss' } });
      fireEvent.keyDown(screen.getByTestId('ced-title'), { key: 'Enter' });
      expect((screen.getByTestId('ced-title') as HTMLInputElement).value).toBe('');
      expect(screen.getByText('New Counter')).toBeTruthy();

      // Save: writes and goes to the list, where the schedule and reward are
      // editable as part of creating the item.
      fireEvent.input(screen.getByTestId('ced-title'), { target: { value: 'Stretch' } });
      fireEvent.click(screen.getByTestId('ced-title-save'));
      expect(screen.getByText('Edit Counter')).toBeTruthy();
      expect(screen.getByTestId('ced-repeat-row')).toBeTruthy();

      fireEvent.click(screen.getByTestId('ced-reward-row'));
      fireEvent.input(screen.getByTestId('ced-reward-goal'), { target: { value: '7' } });
      fireEvent.input(screen.getByTestId('ced-reward-text'), { target: { value: 'Cake' } });
      fireEvent.click(screen.getByTestId('ced-reward-save'));

      fireEvent.click(screen.getByTestId('ced-repeat-row'));
      fireEvent.input(screen.getByTestId('ced-freq'), { target: { value: 'weekly' } });
      fireEvent.click(screen.getByTestId('ced-repeat-save'));

      const stretch = Object.values(eventsOf()).find((e: any) => e.title === 'Stretch') as any;
      expect(stretch).toMatchObject({ description: '7: Cake', recurrenceRule: { frequency: 'weekly' } });
      expect(stretch.created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      // A brand-new counter has no schedule anchor until it is first done.
      expect(stretch.start).toBeUndefined();
    });

    it('a repeat chosen before the title is carried into the counter it creates', async () => {
      mock.__setDoc(DOC, { '@type': 'Calendar+Counters', name: 'C', events: {} });
      render(<Counters docId={DOC} />);
      await waitFor(() => expect(document.querySelector('md-fab')).toBeTruthy());
      fireEvent.click(document.querySelector('md-fab')!);

      // Leave the title pane without a title: nothing is created yet…
      fireEvent.click(screen.getByTestId('ced-title-cancel'));
      fireEvent.click(screen.getByTestId('ced-repeat-row'));
      fireEvent.input(screen.getByTestId('ced-freq'), { target: { value: 'monthly' } });
      fireEvent.click(screen.getByTestId('ced-repeat-save'));
      expect(Object.keys(eventsOf())).toHaveLength(0);

      // …and the choice rides along with the title that does create it.
      fireEvent.click(screen.getByTestId('ced-title-row'));
      fireEvent.input(screen.getByTestId('ced-title'), { target: { value: 'Pay rent' } });
      fireEvent.click(screen.getByTestId('ced-title-save'));
      expect(only()).toMatchObject({ title: 'Pay rent', recurrenceRule: { frequency: 'monthly' } });
    });
  });
});
