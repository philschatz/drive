/**
 * Link Device page — handles QR-code-based device linking.
 *
 * URL format: /#/link-device/{base64url-encoded-contact-card}
 *
 * Flow:
 * 1. Decode the contact card from the URL
 * 2. Call receiveContactCard to link the other device
 * 3. Show this device's own contact card as a QR code for the return trip
 */

import { useState, useCallback } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { receiveContactCard, getContactCard } from '../shared/keyhive-api';
import QRCode from 'qrcode';

interface LinkDevicePageProps {
  cardData?: string;
  path?: string;
}

function decodeCardFromUrl(b64url: string): string {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(atob(b64).split('').map(
    c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
  ).join(''));
}

function encodeCardForUrl(cardJson: string): string {
  const bytes = new TextEncoder().encode(cardJson);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function buildLinkDeviceUrl(cardJson: string): string {
  const base = window.location.origin + window.location.pathname;
  return `${base}#/link-device/${encodeCardForUrl(cardJson)}`;
}

export function LinkDevicePage({ cardData }: LinkDevicePageProps) {
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [myQrSvg, setMyQrSvg] = useState('');
  const [myCardUrl, setMyCardUrl] = useState('');

  const doLink = useCallback(async () => {
    if (!cardData) {
      setError('Invalid link — missing contact card data.');
      return;
    }
    setProcessing(true);
    setError(null);

    try {
      setStatus('Decoding contact card...');
      const cardJson = decodeCardFromUrl(cardData);

      setStatus('Linking device...');
      await receiveContactCard(cardJson);

      setStatus('Generating your contact card...');
      const myCard = await getContactCard();
      const url = buildLinkDeviceUrl(myCard);
      setMyCardUrl(url);
      const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 200 });
      setMyQrSvg(svg);

      setDone(true);
      setStatus('Device linked! Now scan this QR code from the other device to complete linking.');
    } catch (err: any) {
      setError(err.message || 'Failed to link device');
    } finally {
      setProcessing(false);
    }
  }, [cardData]);

  // Auto-start on first render
  if (!status && !error && !done && !processing) {
    doLink();
  }

  return (
    <div className="max-w-md mx-auto p-8 text-center">
      <h1 className="text-xl font-bold mb-4">
        <span className="material-symbols-outlined align-middle mr-1" style={{ fontSize: 24 }}>devices</span>
        Link Device
      </h1>

      {error ? (
        <div className="text-destructive mb-4">
          <p className="mb-2">{error}</p>
          <div className="flex gap-2 justify-center">
            <Button variant="default" onClick={doLink} disabled={processing}>
              Retry
            </Button>
            <Button variant="outline" onClick={() => { window.location.hash = '/settings'; }}>
              Back to Settings
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <p className="text-sm text-muted-foreground mb-4">{status}</p>
          {done && (
            <>
              <p className="text-sm text-green-600 font-medium mb-4">
                <span className="material-symbols-outlined align-middle mr-1" style={{ fontSize: 16 }}>check_circle</span>
                Their device linked to yours
              </p>
              {myQrSvg && (
                <div className="mb-4">
                  <p className="text-xs text-muted-foreground mb-2">
                    Scan this from the other device to link yours to theirs:
                  </p>
                  <div className="flex justify-center" dangerouslySetInnerHTML={{ __html: myQrSvg }} />
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      className="flex-1 text-xs p-2 rounded border border-border font-mono bg-muted"
                      value={myCardUrl}
                      readOnly
                      onClick={(e: any) => e.currentTarget.select()}
                    />
                    <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(myCardUrl)}>
                      Copy
                    </Button>
                  </div>
                </div>
              )}
              <Button variant="outline" onClick={() => { window.location.hash = '/settings'; }}>
                Done
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
