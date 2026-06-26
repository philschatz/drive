/**
 * Link Device page — handles QR-code-based device linking.
 *
 * URL format: /#/link-device/{base64url-encoded-contact-card}
 *
 * Device linking is a two-way handshake. This page handles both legs:
 * 1. Decode the contact card from the URL and receiveContactCard / linkDevice.
 * 2. If we are the original (admin) device, linkDevice adds the peer and the
 *    handshake is complete — show "Linking complete".
 * 3. Otherwise (the new device), show this device's own contact card as a return
 *    QR code for the original device to open and finish the handshake.
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

      setStatus('Linking this device...');
      const result = await receiveContactCard(cardJson, { isDevice: true });
      if (result.isOwnCard) {
        setError("This is your own device's link. Open this link on a different device to link it.");
        return;
      }

      // Join the same user-group (adopting the peer's group id if we don't have one yet).
      setStatus('Joining your account...');
      const { linked } = await linkDevice(result.agentId, peerGroupId);

      if (linked) {
        // Both devices are now members — the handshake is complete (this is the
        // second leg, back on the original device). No return QR needed.
        setStatus('');
        setDone(true);
      } else {
        // First leg, on the new device — produce a return link for the original
        // device to open and finish the handshake.
        setStatus('Generating your link...');
        const { card: myCard, userGroupId: myGroupId } = await getLinkPayload();
        setMyCardUrl(buildLinkDeviceUrl(myCard, myGroupId));
        setStatus('');
        setDone(true);
      }
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
              {myCardUrl ? (
                <>
                  <p className="text-sm font-medium mb-4">Almost done — finish on your original device</p>
                  <div className="mb-4">
                    <p className="text-xs text-muted-foreground mb-2">
                      Open this link (or scan this QR code) on your original device to complete the handshake:
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
                </>
              ) : (
                <p className="text-sm text-green-600 font-medium mb-4">
                  <span className="material-symbols-outlined align-middle mr-1" style={{ fontSize: 16 }}>check_circle</span>
                  Linking complete
                </p>
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
