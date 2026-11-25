jest.mock('./worker-api');
jest.mock('../shared/idb-storage', () => ({
  settingSet: jest.fn(() => Promise.resolve()),
  settingSetSync: jest.fn(),
}));
// A document type whose view knows nothing about presence — the case a future
// doc type starts from.
jest.mock('./doc-plugins', () => ({
  getDocPlugin: (type: unknown) =>
    type === 'Plain' ? { type: 'Plain', View: () => <div data-testid="plain-view">plain</div> } : undefined,
}));

import { render, screen, waitFor } from '@testing-library/preact';
import * as workerApi from './worker-api';
import { DocRoute } from './DocRoute';

const mock = workerApi as any;
const DOC = 'doc-1';

describe('DocRoute', () => {
  beforeEach(() => {
    expect(mock.__isMock).toBe(true);
    mock.__reset();
  });

  it('announces viewing for a view that never mentions presence', async () => {
    mock.__setDoc(DOC, { '@type': 'Plain' });
    render(<DocRoute docId={DOC} />);
    await screen.findByTestId('plain-view');
    // The view arrives through async state, so its effects flush a tick later.
    await waitFor(() => expect(mock.__presenceSent(DOC)).toEqual({ viewing: true, focusedField: null }));
  });

  it('does not announce viewing for a document no editor renders', async () => {
    mock.__setDoc(DOC, { '@type': 'Mystery' });
    render(<DocRoute docId={DOC} />);
    await screen.findByText(/not supported by any editor/);
    expect(mock.__presenceSent(DOC)).toBeUndefined();
  });
});
