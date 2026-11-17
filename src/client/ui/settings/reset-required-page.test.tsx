/**
 * The "Reset needed" screen: the whole UI of a device whose saved keyhive state
 * is from an older version. Its contract is about ORDER and CONSENT — nothing
 * reaches the engine before a tap, the destructive step is confirmed, and the
 * confirmation says so when no backup was downloaded first.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

let mockExportLegacyBackup: jest.Mock;
let mockResetKeyhive: jest.Mock;
let mockShowToast: jest.Mock;
let mockShowError: jest.Mock;

jest.mock('../worker-api', () => ({
  exportLegacyBackup: (...args: any[]) => mockExportLegacyBackup(...args),
  resetKeyhive: (...args: any[]) => mockResetKeyhive(...args),
}));
jest.mock('@/components/ui/toast', () => ({
  showToast: (...args: any[]) => mockShowToast(...args),
  showError: (...args: any[]) => mockShowError(...args),
}));

import { ResetRequiredPage } from './ResetRequiredPage';

const payload = { format: 'drive-backup', version: 1, kind: 'snapshot', exportedAt: '2026-11-16T00:00:00.000Z', docs: [{}, {}, {}] };

beforeEach(() => {
  mockExportLegacyBackup = jest.fn(() => Promise.resolve({ payload, unreadable: [] }));
  mockResetKeyhive = jest.fn(() => Promise.resolve());
  mockShowToast = jest.fn();
  mockShowError = jest.fn();
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  (URL as any).createObjectURL = jest.fn(() => 'blob:x');
  (URL as any).revokeObjectURL = jest.fn();
});
afterEach(() => { jest.restoreAllMocks(); });

describe('ResetRequiredPage', () => {
  it('explains the situation and does nothing until a tap', () => {
    render(<ResetRequiredPage info={{ reason: 'archive-format', docCount: 3 }} />);
    expect(screen.getByRole('heading').textContent).toBe('Reset needed');
    expect(screen.getByTestId('reset-download-backup').textContent).toMatch(/3 documents and your settings/);
    expect(mockExportLegacyBackup).not.toHaveBeenCalled();
    expect(mockResetKeyhive).not.toHaveBeenCalled();
  });

  it('says "1 document" for one', () => {
    render(<ResetRequiredPage info={{ reason: 'archive-format', docCount: 1 }} />);
    expect(screen.getByTestId('reset-download-backup').textContent).toMatch(/1 document and your settings/);
  });

  it('downloads a backup file built without keyhive', async () => {
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<ResetRequiredPage info={{ reason: 'archive-format', docCount: 3 }} />);
    fireEvent.click(screen.getByTestId('reset-download-backup'));

    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(mockExportLegacyBackup).toHaveBeenCalledTimes(1);
    expect(mockShowToast).toHaveBeenCalledWith('Saved 3 documents.');
    expect(mockResetKeyhive).not.toHaveBeenCalled();
  });

  it('names what could not be read instead of pretending the backup is complete', async () => {
    mockExportLegacyBackup = jest.fn(() => Promise.resolve({ payload: { ...payload, docs: [{}, {}] }, unreadable: ['Garbled'] }));
    render(<ResetRequiredPage info={{ reason: 'archive-format', docCount: 3 }} />);
    fireEvent.click(screen.getByTestId('reset-download-backup'));
    await waitFor(() => expect(mockShowError).toHaveBeenCalled());
    expect(mockShowError.mock.calls[0][0]).toMatch(/Saved 2 documents\. 1 could not be read: Garbled/);
  });

  it('warns in the confirmation when no backup was downloaded', async () => {
    render(<ResetRequiredPage info={{ reason: 'archive-format', docCount: 3 }} />);
    fireEvent.click(screen.getByTestId('reset-device'));

    const sheet = await screen.findByTestId('confirm-reset-device');
    expect(sheet.textContent).toMatch(/You haven't downloaded a backup/);
    expect(mockResetKeyhive).not.toHaveBeenCalled();
  });

  it('does not warn once a backup was downloaded', async () => {
    render(<ResetRequiredPage info={{ reason: 'archive-format', docCount: 3 }} />);
    fireEvent.click(screen.getByTestId('reset-download-backup'));
    await waitFor(() => expect(mockShowToast).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('reset-device'));
    const sheet = await screen.findByTestId('confirm-reset-device');
    expect(sheet.textContent).not.toMatch(/haven't downloaded/);
  });

  it('does not warn when there is nothing to back up', async () => {
    render(<ResetRequiredPage info={{ reason: 'archive-format', docCount: 0 }} />);
    fireEvent.click(screen.getByTestId('reset-device'));
    const sheet = await screen.findByTestId('confirm-reset-device');
    expect(sheet.textContent).not.toMatch(/haven't downloaded/);
  });

  it('resets only after the confirmation is accepted', async () => {
    render(<ResetRequiredPage info={{ reason: 'archive-format', docCount: 3 }} />);
    fireEvent.click(screen.getByTestId('reset-device'));
    fireEvent.click(await screen.findByTestId('confirm-accept'));
    await waitFor(() => expect(mockResetKeyhive).toHaveBeenCalledTimes(1));
  });

  it('resets nothing when the confirmation is declined', async () => {
    render(<ResetRequiredPage info={{ reason: 'archive-format', docCount: 3 }} />);
    fireEvent.click(screen.getByTestId('reset-device'));
    fireEvent.click(await screen.findByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-reset-device')).toBeNull());
    expect(mockResetKeyhive).not.toHaveBeenCalled();
  });

  it('reports a failed reset and stays on the screen', async () => {
    mockResetKeyhive = jest.fn(() => Promise.reject(new Error('disk full')));
    render(<ResetRequiredPage info={{ reason: 'archive-format', docCount: 3 }} />);
    fireEvent.click(screen.getByTestId('reset-device'));
    fireEvent.click(await screen.findByTestId('confirm-accept'));
    await waitFor(() => expect(mockShowError).toHaveBeenCalledWith('Reset failed: disk full'));
    expect(screen.getByTestId('reset-device')).toBeDefined();
  });
});
