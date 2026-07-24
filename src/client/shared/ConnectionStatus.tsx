import { useWsStatus } from './automerge';

/**
 * Relay connection status indicator — a link to the Connection page (`#/connection`).
 * Reused by Home (with a colored status dot) and the EditorTitleBar (label only).
 */
export function ConnectionStatus({
  showDot = false,
  className = '',
}: {
  showDot?: boolean;
  className?: string;
}) {
  const connected = useWsStatus();
  return (
    <a
      href="#/connection"
      className={`flex items-center gap-2 cursor-pointer hover:opacity-80 ${className}`}
      title={connected
        ? 'Connected to relay. Tap for connection details.'
        : 'Not connected to relay. Tap for connection details.'}
    >
      {showDot && (
        <div
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: connected ? '#4caf50' : '#f44336' }}
        />
      )}
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {connected ? 'Connected' : 'Disconnected'}
      </span>
    </a>
  );
}
