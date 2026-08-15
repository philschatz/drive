import { useState, useEffect } from 'preact/hooks';
import QRCode from 'qrcode';
import { showToast } from './toast';
import { createLogger } from '../../../../shared/logger';

const log = createLogger('qr-code');

interface QRCodeProps {
  url: string;
  size?: number;
  className?: string;
}

export function QRCodeDisplay({ url, size = 200, className }: QRCodeProps) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setError('');
    // errorCorrectionLevel 'L' maximizes byte-mode capacity (~2331 → ~2953 chars).
    // Every URL we encode is now a short rendezvous token, so overflow should be
    // unreachable — but surface a failure rather than silently rendering nothing.
    QRCode.toString(url, { type: 'svg', margin: 1, width: size, errorCorrectionLevel: 'L' })
      .then(svg => { setSvg(svg); setError(''); })
      .catch(err => {
        log.error(`failed to render QR (url length ${url.length}):`, err);
        setSvg('');
        setError(err?.message ?? 'Could not render QR code');
      });
  }, [url, size]);

  if (error) {
    return (
      <div className={`flex justify-center w-full ${className ?? ''}`}>
        <div className="text-xs text-muted-foreground border border-border rounded p-3 max-w-[200px] text-center">
          Payload too large for a QR code — use the link below instead.
        </div>
      </div>
    );
  }

  if (!svg) return null;

  const handleClick = () => {
    navigator.clipboard.writeText(url).then(
      () => showToast('Link copied to clipboard'),
      () => showToast('Failed to copy link'),
    );
  };

  return (
    // A centered Material surface card: the QR's own white quiet zone sits on a
    // rounded container tone, so it reads as an element rather than a floating
    // square. `w-full` + `flex justify-center` centers it in whatever surface
    // hosts it (sheet, page), so call sites don't each need a wrapper.
    <div className={`flex justify-center w-full ${className ?? ''}`}>
      <div
        className="cursor-pointer rounded-2xl bg-surface-container-highest p-4"
        onClick={handleClick}
        title="Click to copy link"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}
