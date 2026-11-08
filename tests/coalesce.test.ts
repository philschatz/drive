import { coalesce } from '../src/shared/coalesce';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('coalesce', () => {
  it('delivers only the latest value once the burst pauses', () => {
    const got: number[] = [];
    const c = coalesce<number>(v => got.push(v), { wait: 100, maxWait: 250 });
    c(1); c(2); c(3);
    jest.advanceTimersByTime(99);
    expect(got).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(got).toEqual([3]);
    expect(c.pending).toBe(false);
  });

  it('cannot be starved: a burst that never pauses still delivers every maxWait', () => {
    const got: Array<[number, number]> = [];
    const c = coalesce<number>(v => got.push([v, Date.now()]), { wait: 100, maxWait: 250 });
    const t0 = Date.now();
    // One call every 50 ms for 600 ms — the trailing 100 ms timer never fires on its own.
    for (let t = 0; t <= 600; t += 50) {
      c(t);
      jest.advanceTimersByTime(50);
    }
    // Deliveries at 250 and 500 (the value current at the deadline), then the
    // trailing one 100 ms after the last call at 600.
    jest.advanceTimersByTime(100);
    expect(got.map(([v, at]) => [v, at - t0])).toEqual([[200, 250], [450, 500], [600, 700]]);
  });

  it('flush delivers now and cancel drops', () => {
    const got: number[] = [];
    const c = coalesce<number>(v => got.push(v), { wait: 100, maxWait: 250 });
    c(1);
    c.flush();
    expect(got).toEqual([1]);
    c.flush(); // nothing pending
    expect(got).toEqual([1]);
    c(2);
    expect(c.pending).toBe(true);
    c.cancel();
    jest.advanceTimersByTime(1000);
    expect(got).toEqual([1]);
    expect(c.pending).toBe(false);
  });
});
