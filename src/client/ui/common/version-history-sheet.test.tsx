/**
 * The version list as a scrubber: scrolling it selects a version, and the
 * slider scrolls it. jsdom has no layout, so the list is given its geometry by
 * hand — eight 40px rows in a 120px viewport — and `scrollTop` is set directly
 * (jsdom forwards it as a plain property).
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { useEffect } from 'preact/hooks';

jest.mock('../worker-api');
import * as api from '../worker-api';
import { useDocumentHistory } from './useDocumentHistory';
import { HistorySlider } from './HistorySlider';

const mock = api as any;

it('uses the manual worker-api mock', () => expect(mock.__isMock).toBe(true));

const DOC = 'doc-history';
const T = 1_770_000_000;
const HISTORY = Array.from({ length: 8 }, (_, v) => ({ version: v, time: T - (8 - v) * 60 }));

function Host() {
  const history = useDocumentHistory(DOC);
  useEffect(() => { history.toggleHistory(); }, []);
  return <HistorySlider history={history} />;
}

const rows = () => Array.from(document.querySelectorAll('[data-testid="history-row"]')) as HTMLElement[];
const current = () => rows().find(r => r.className.includes('bg-muted'))?.getAttribute('data-version');
const slider = () => document.querySelector('input[type="range"]') as HTMLInputElement;

async function open() {
  mock.__setHistory(DOC, HISTORY);
  render(<Host />);
  const list = await waitFor(() => screen.getByTestId('history-versions'));
  await waitFor(() => expect(rows().length).toBe(8));
  rows().forEach((r, i) => {
    Object.defineProperty(r, 'offsetTop', { value: i * 40, configurable: true });
    Object.defineProperty(r, 'offsetHeight', { value: 40, configurable: true });
  });
  Object.defineProperty(list, 'clientHeight', { value: 120, configurable: true });
  Object.defineProperty(list, 'scrollHeight', { value: 320, configurable: true });
  return list;
}

const scrollTo = (list: HTMLElement, top: number) => { list.scrollTop = top; fireEvent.scroll(list); };

beforeEach(() => mock.__reset());

describe('version history sheet', () => {
  it('opens at the latest version, newest first, list at the top', async () => {
    const list = await open();
    expect(mock.__getPinnedVersion()).toBe(7);
    expect(current()).toBe('7');
    expect(rows().map(r => r.getAttribute('data-version'))).toEqual(['7', '6', '5', '4', '3', '2', '1', '0']);
    expect(list.scrollTop).toBe(0);
  });

  it('scrolling down selects the row at the top edge, and does not snap the list back', async () => {
    const list = await open();
    scrollTo(list, 80);
    await waitFor(() => expect(mock.__getPinnedVersion()).toBe(5));
    expect(current()).toBe('5');
    expect(list.scrollTop).toBe(80);
  });

  it('keeps the selection while its row is visible; the top selects the newest', async () => {
    const list = await open();
    scrollTo(list, 80);
    await waitFor(() => expect(mock.__getPinnedVersion()).toBe(5));
    scrollTo(list, 60);
    expect(mock.__getPinnedVersion()).toBe(5);
    scrollTo(list, 0);
    await waitFor(() => expect(mock.__getPinnedVersion()).toBe(7));
  });

  it('the bottom selects the oldest', async () => {
    const list = await open();
    scrollTo(list, 200);
    await waitFor(() => expect(mock.__getPinnedVersion()).toBe(0));
    expect(current()).toBe('0');
  });

  it('the slider brings a row below the viewport to the top edge, and that scroll is not a user scroll', async () => {
    const list = await open();
    fireEvent.input(slider(), { target: { value: '2' } });
    await waitFor(() => expect(mock.__getPinnedVersion()).toBe(2));
    // Version 2 is the sixth row (top 200); 200 is also the end of the list, so
    // the scroll event this causes must not trip the "bottom ⇒ oldest" rule.
    expect(list.scrollTop).toBe(200);
    fireEvent.scroll(list);
    expect(mock.__getPinnedVersion()).toBe(2);
    expect(current()).toBe('2');
  });

  it('the slider brings a row above the viewport to the bottom edge', async () => {
    const list = await open();
    scrollTo(list, 200);
    await waitFor(() => expect(mock.__getPinnedVersion()).toBe(0));
    // Version 4 is the fourth row (120–160): bottom edge ⇒ scrollTop 40.
    fireEvent.input(slider(), { target: { value: '4' } });
    await waitFor(() => expect(list.scrollTop).toBe(40));
    expect(mock.__getPinnedVersion()).toBe(4);
  });

  it('the slider leaves a visible row where it is', async () => {
    const list = await open();
    fireEvent.input(slider(), { target: { value: '6' } });
    await waitFor(() => expect(mock.__getPinnedVersion()).toBe(6));
    expect(list.scrollTop).toBe(0);
  });

  it('shows what the version on screen changed once its description lands', async () => {
    mock.__setVersionChanges(DOC, 7, [
      { path: ['tasks', 'a'], kind: 'added', action: 'put' },
      { path: ['tasks', 'b', 'title'], kind: 'changed', action: 'put' },
      { path: ['tasks', 'c'], kind: 'removed', action: 'del', before: {} },
    ]);
    await open();
    const legend = await waitFor(() => screen.getByTestId('history-legend'));
    expect(legend.textContent).toMatch(/1 added.*1 changed.*1 removed/);
  });

  it('tapping a row previews it', async () => {
    await open();
    fireEvent.click(rows()[3].querySelector('button')!);
    await waitFor(() => expect(mock.__getPinnedVersion()).toBe(4));
    expect(current()).toBe('4');
  });
});
