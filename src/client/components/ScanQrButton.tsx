/**
 * ScanQrButton — a self-contained "Scan their QR Code" trigger. Renders a button
 * that opens the full-screen QrScanner camera overlay and, on a decoded result,
 * routes to the scanned link (contact rendezvous, device link, or document URL).
 * Drop it into any page's header; scan errors are reported via onError so the host
 * can show them in its own Alert.
 */

import { useState } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { QrScanner } from '@/components/QrScanner';
import { navigateToUrlOrHash } from '@/shared/navigate-url';

interface ScanQrButtonProps {
  className?: string;
  onError?: (message: string) => void;
}

export function ScanQrButton({ className, onError }: ScanQrButtonProps) {
  const [scanning, setScanning] = useState(false);

  const handleResult = (text: string) => {
    setScanning(false);
    const err = navigateToUrlOrHash(text);
    if (err) onError?.(`Scanned code is not a recognized link — ${err.toLowerCase()}`);
  };

  return (
    <>
      <Button variant="outline" size="sm" className={className} onClick={() => setScanning(true)}>
        <span className="material-symbols-outlined mr-1" style={{ fontSize: 16 }}>qr_code_scanner</span>
        Scan their QR Code
      </Button>
      {scanning && (
        <QrScanner onResult={handleResult} onClose={() => setScanning(false)} />
      )}
    </>
  );
}
