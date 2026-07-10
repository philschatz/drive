import { renderHook, act, waitFor } from '@testing-library/preact';

let mockGetMyAccess: jest.Mock;
const stateChangeListeners = new Set<() => void>();

jest.mock('./keyhive-api', () => ({
  getMyAccess: (...args: any[]) => mockGetMyAccess(...args),
  onKeyhiveStateChanged: (fn: () => void) => {
    stateChangeListeners.add(fn);
    return () => { stateChangeListeners.delete(fn); };
  },
}));

import { useAccess } from './useAccess';

beforeEach(() => {
  mockGetMyAccess = jest.fn(() => Promise.resolve(null));
  stateChangeListeners.clear();
});

describe('useAccess', () => {
  it('returns canEdit: true and loaded: true when no docId (unshared doc)', () => {
    const { result } = renderHook(() => useAccess(undefined));
    expect(result.current).toEqual({ access: null, canEdit: true, loaded: true });
    expect(mockGetMyAccess).not.toHaveBeenCalled();
  });

  it('returns canEdit: true when access is admin', async () => {
    mockGetMyAccess.mockResolvedValue('Admin');
    const { result } = renderHook(() => useAccess('kh-doc-1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current).toEqual({ access: 'admin', canEdit: true, loaded: true });
  });

  it('returns canEdit: true when access is write', async () => {
    mockGetMyAccess.mockResolvedValue('Edit');
    const { result } = renderHook(() => useAccess('kh-doc-1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current).toEqual({ access: 'edit', canEdit: true, loaded: true });
  });

  it('returns canEdit: false when access is read', async () => {
    mockGetMyAccess.mockResolvedValue('Read');
    const { result } = renderHook(() => useAccess('kh-doc-1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current).toEqual({ access: 'read', canEdit: false, loaded: true });
  });

  it('returns canEdit: false and access: null when fetch returns null (no access)', async () => {
    mockGetMyAccess.mockResolvedValue(null);
    const { result } = renderHook(() => useAccess('kh-doc-1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current).toEqual({ access: null, canEdit: false, loaded: true });
  });

  it('loaded starts false, becomes true after fetch resolves', async () => {
    let resolve!: (v: string) => void;
    mockGetMyAccess.mockReturnValue(new Promise(r => { resolve = r; }));
    const { result } = renderHook(() => useAccess('kh-doc-1'));

    expect(result.current.loaded).toBe(false);
    expect(result.current.canEdit).toBe(false);

    await act(async () => { resolve('Edit'); });
    expect(result.current.loaded).toBe(true);
    expect(result.current.canEdit).toBe(true);
    expect(result.current.access).toBe('edit');
  });

  it('returns canEdit: false when fetch rejects', async () => {
    mockGetMyAccess.mockRejectedValue(new Error('fail'));
    const { result } = renderHook(() => useAccess('kh-doc-1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current).toEqual({ access: null, canEdit: false, loaded: true });
  });

  it('re-fetches access when keyhive state changes', async () => {
    mockGetMyAccess.mockResolvedValue('Edit');
    const { result } = renderHook(() => useAccess('kh-doc-1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.access).toBe('edit');

    // Simulate access revocation
    mockGetMyAccess.mockResolvedValue(null);
    await act(async () => {
      for (const fn of stateChangeListeners) fn();
    });
    await waitFor(() => expect(result.current.access).toBe(null));
    expect(result.current.canEdit).toBe(false);
  });

  it('a stale response for a previous docId does not overwrite the current doc access', async () => {
    // docId 'A' resolves slowly; docId 'B' resolves fast. After switching to 'B',
    // the late 'A' response must be ignored (cancellation guard).
    let resolveA!: (v: string) => void;
    mockGetMyAccess.mockImplementation((id: string) => {
      if (id === 'doc-A') return new Promise<string>(r => { resolveA = r; });
      return Promise.resolve('Admin'); // doc-B
    });

    const { result, rerender } = renderHook((id: string) => useAccess(id), { initialProps: 'doc-A' });
    // Switch to doc-B before doc-A's request resolves.
    rerender('doc-B');
    await waitFor(() => expect(result.current.access).toBe('admin'));

    // The stale doc-A response arrives late — it must NOT clobber doc-B's access.
    await act(async () => { resolveA('Read'); });
    expect(result.current.access).toBe('admin');
    expect(result.current.canEdit).toBe(true);
  });

  it('re-fetches access when keyhive state changes (grant)', async () => {
    mockGetMyAccess.mockResolvedValue('Read');
    const { result } = renderHook(() => useAccess('kh-doc-1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.canEdit).toBe(false);

    // Simulate access upgrade
    mockGetMyAccess.mockResolvedValue('Admin');
    await act(async () => {
      for (const fn of stateChangeListeners) fn();
    });
    await waitFor(() => expect(result.current.access).toBe('admin'));
    expect(result.current.canEdit).toBe(true);
  });
});
