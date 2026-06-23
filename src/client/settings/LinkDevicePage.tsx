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
import { QRCodeDisplay } from '@/components/ui/qr-code';
import { receiveContactCard, linkDevice, getLinkPayload } from '../shared/keyhive-api';
import { deflate, inflate } from 'pako';

interface LinkDevicePageProps {
  cardData?: string;
  path?: string;
}

function b64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeStringFromUrl(b64url: string): string {
  return new TextDecoder().decode(inflate(b64urlToBytes(b64url)));
}

function encodeStringForUrl(value: string): string {
  const compressed = deflate(new TextEncoder().encode(value));
  return bytesToB64url(compressed);
}

/** Build a device-link URL embedding the contact card and this user's group id. */
export function buildLinkDeviceUrl(cardJson: string, userGroupId?: string | null): string {
  const base = window.location.origin + window.location.pathname;
  const payload = JSON.stringify({ card: cardJson, userGroupId: userGroupId ?? null });
  return `${base}#/link-device/${encodeStringForUrl(payload)}`;
}

/** Decode a device-link payload, tolerating the legacy raw-card format. */
function decodeLinkData(b64url: string): { cardJson: string; userGroupId: string | null } {
  const raw = decodeStringFromUrl(b64url);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.card === 'string') {
      return { cardJson: parsed.card, userGroupId: parsed.userGroupId ?? null };
    }
  } catch {
    // Not the wrapper format — old-style raw card JSON
  }
  return { cardJson: raw, userGroupId: null };
}

export function LinkDevicePage({ cardData }: LinkDevicePageProps) {
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [processing, setProcessing] = useState(false);
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
      const { cardJson, userGroupId: peerGroupId } = decodeLinkData(cardData);

      setStatus('Linking device...');
      const result = await receiveContactCard(cardJson, { isDevice: true });
      if (result.isOwnCard) {
        setError("This is your own device's link. Open this link on a different device to link it.");
        return;
      }

      // Join the same user-group (adopting the peer's group id if we don't have one yet).
      setStatus('Joining your user group...');
      await linkDevice(result.agentId, peerGroupId);

      setStatus('Generating your contact card...');
      const { card: myCard, userGroupId: myGroupId } = await getLinkPayload();
      setMyCardUrl(buildLinkDeviceUrl(myCard, myGroupId));

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
              {myCardUrl && (
                <div className="mb-4">
                  <p className="text-xs text-muted-foreground mb-2">
                    Scan this from the other device to link yours to theirs:
                  </p>
                  <div className="flex justify-center">
                    <QRCodeDisplay url={myCardUrl} />
                  </div>
                  <input
                    className="mt-2 text-xs p-2 rounded border border-border font-mono bg-muted w-full"
                    value={myCardUrl}
                    readOnly
                    onClick={(e: any) => e.currentTarget.select()}
                  />
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
