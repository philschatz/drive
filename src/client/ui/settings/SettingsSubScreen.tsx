/**
 * Shared layout for Settings sub-screens: a Material top app bar with a back
 * button to the Settings index, plus per-section success/error alerts.
 */
import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Alert } from '@/components/ui/alert';

export function SettingsSubScreen({ title, children }: { title: string; children?: ComponentChildren }) {
  return (
    <div className="max-w-screen-md mx-auto px-2 sm:px-4 pb-8">
      <div className="flex items-center gap-1.5 pl-1 min-h-14">
        <a
          href="#/settings"
          aria-label="Back"
          className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer shrink-0"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 24 }}>arrow_back</span>
        </a>
        <h1 className="md-title-large font-bold flex-1 min-w-0 truncate">{title}</h1>
      </div>
      <div className="px-2">{children}</div>
    </div>
  );
}

/** Local success/error alert pair used by each settings section. */
export function useSectionAlerts() {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const alerts = (
    <>
      {message && (
        <Alert variant="success" className="mb-2 flex items-center justify-between">
          <span>{message}</span>
          <button className="ml-2 opacity-50 hover:opacity-100" onClick={() => setMessage('')}>&times;</button>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" className="mb-2 flex items-center justify-between">
          <span>{error}</span>
          <button className="ml-2 opacity-50 hover:opacity-100" onClick={() => setError('')}>&times;</button>
        </Alert>
      )}
    </>
  );
  return { alerts, setMessage, setError };
}
