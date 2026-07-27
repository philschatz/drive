import { useState, useEffect, useCallback } from 'preact/hooks';

declare const __APP_VERSION__: string;

interface VersionInfo {
  commitSha: string;
  buildTime: string;
}

interface VersionCheckResult {
  updateAvailable: boolean;
  buildTime: string | null;
  reload: () => void;
  dismiss: () => void;
  dismissed: boolean;
}

const POLL_INTERVAL = 60_000; // 60 seconds

export function useVersionCheck(): VersionCheckResult {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [buildTime, setBuildTime] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const checkVersion = useCallback(async () => {
    try {
      const base = import.meta.env.BASE_URL;
      const res = await fetch(`${base}version.json?t=${Date.now()}`);
      if (!res.ok) return;
      const info: VersionInfo = await res.json();
      if (info.commitSha && info.commitSha !== __APP_VERSION__) {
        setUpdateAvailable(true);
        setBuildTime(info.buildTime);
      }
    } catch {
      // Network error — skip this check
    }
  }, []);

  useEffect(() => {
    checkVersion();
    const id = setInterval(checkVersion, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [checkVersion]);

  const reload = useCallback(() => {
    window.location.reload();
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  return { updateAvailable, buildTime, reload, dismiss, dismissed };
}
