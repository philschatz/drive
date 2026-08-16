/**
 * The md-* custom elements are registered only in main.tsx, so under jsdom they
 * never upgrade — which is exactly the mode these wrappers fall back for. These
 * tests pin the fallback contract the editor tests depend on: a real
 * input/textarea/select, driven by fireEvent, with commit on focusout.
 */
import { render, screen, fireEvent } from '@testing-library/preact';
import { MdTextField } from './md-text-field';
import { MdSelect } from './md-select';
import { MdSlider } from './md-slider';

/** preact/compat aliases onBlur → focusout, which fireEvent.blur does not reach. */
const focusout = (el: Element) =>
  fireEvent(el, new FocusEvent('focusout', { bubbles: true }));

describe('MdTextField (jsdom fallback)', () => {
  it('renders a real input carrying the id and testid', () => {
    render(<MdTextField label="Title" value="hi" id="f-title" data-testid="f-title" />);
    const el = screen.getByTestId('f-title');
    expect(el.tagName).toBe('INPUT');
    expect(el.id).toBe('f-title');
    expect((el as HTMLInputElement).value).toBe('hi');
    expect(screen.getByText('Title')).toBeTruthy();
  });

  it('round-trips fireEvent.input through onInput', () => {
    const onInput = jest.fn();
    render(<MdTextField label="Title" value="" data-testid="f" onInput={onInput} />);
    fireEvent.input(screen.getByTestId('f'), { target: { value: 'typed' } });
    expect(onInput).toHaveBeenCalledWith('typed', expect.anything());
  });

  it('commits on focusout', () => {
    const onCommit = jest.fn();
    render(<MdTextField label="Title" value="" data-testid="f" onCommit={onCommit} />);
    const el = screen.getByTestId('f');
    fireEvent.input(el, { target: { value: 'done' } });
    focusout(el);
    expect(onCommit).toHaveBeenCalledWith('done');
  });

  it('Enter calls onEnter instead of onCommit when both are given', () => {
    const onEnter = jest.fn();
    const onCommit = jest.fn();
    render(<MdTextField label="T" value="" data-testid="f" onEnter={onEnter} onCommit={onCommit} />);
    const el = screen.getByTestId('f');
    fireEvent.input(el, { target: { value: 'x' } });
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(onEnter).toHaveBeenCalledWith('x');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('Enter commits when there is no onEnter', () => {
    const onCommit = jest.fn();
    render(<MdTextField label="T" value="" data-testid="f" onCommit={onCommit} />);
    const el = screen.getByTestId('f');
    fireEvent.input(el, { target: { value: 'x' } });
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('x');
  });

  it('type="textarea" renders a textarea and does not intercept Enter', () => {
    const onEnter = jest.fn();
    render(<MdTextField label="Notes" value="" type="textarea" data-testid="f" onEnter={onEnter} />);
    const el = screen.getByTestId('f');
    expect(el.tagName).toBe('TEXTAREA');
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(onEnter).not.toHaveBeenCalled();
  });
});

describe('MdSelect (jsdom fallback)', () => {
  const OPTS = [
    { value: 'daily', label: 'Daily' },
    { value: 'weekly', label: 'Weekly' },
  ];

  // Driven with fireEvent.input, not .change: preact/compat rewrites onChange to
  // an input listener on form elements, so `input` is the event that works in
  // every mode. See the note in md-select.tsx.
  it('renders a native select that fireEvent.input can drive', () => {
    const onValueChange = jest.fn();
    render(
      <MdSelect label="Repeat" value="daily" options={OPTS} data-testid="s" onValueChange={onValueChange} />,
    );
    const el = screen.getByTestId('s') as HTMLSelectElement;
    expect(el.tagName).toBe('SELECT');
    expect(el.value).toBe('daily');
    fireEvent.input(el, { target: { value: 'weekly' } });
    expect(onValueChange).toHaveBeenCalledWith('weekly');
  });
});

describe('MdSlider (jsdom fallback)', () => {
  it('renders a real range input carrying min/max/value and the testid', () => {
    render(<MdSlider label="Priority" value={5} min={1} max={9} id="f-prio" data-testid="f-prio" supportingText="1 is highest" />);
    const el = screen.getByTestId('f-prio') as HTMLInputElement;
    expect(el.tagName).toBe('INPUT');
    expect(el.type).toBe('range');
    expect(el.id).toBe('f-prio');
    expect(el.min).toBe('1');
    expect(el.max).toBe('9');
    expect(el.value).toBe('5');
    expect(screen.getByText('Priority')).toBeTruthy();
    expect(screen.getByText('1 is highest')).toBeTruthy();
  });

  it('round-trips fireEvent.input through onInput as a number', () => {
    const onInput = jest.fn();
    render(<MdSlider label="Priority" value={5} min={1} max={9} data-testid="f" onInput={onInput} />);
    fireEvent.input(screen.getByTestId('f'), { target: { value: '3' } });
    expect(onInput).toHaveBeenCalledWith(3, expect.anything());
  });
});
