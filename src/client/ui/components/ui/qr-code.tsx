import { useState, useEffect } from 'preact/hooks';
import QRCode from 'qrcode';
import { showToast } from './toast';

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
    // errorCorrectionLevel 'L' maximizes byte-mode capacity (~2331 → ~2953 chars)
    // so large compressed contact-card URLs still fit. If they overflow even that,
    // surface the failure instead of silently rendering nothing.
    QRCode.toString(url, { type: 'svg', margin: 1, width: size, errorCorrectionLevel: 'L' })
      .then(svg => { setSvg(svg); setError(''); })
      .catch(err => {
        console.error('[QRCodeDisplay] failed to render QR (url length %d):', url.length, err);
        setSvg('');
        setError(err?.message ?? 'Could not render QR code');
      });
  }, [url, size]);

  if (error) {
    return (
      <div
        className={`text-xs text-muted-foreground border border-border rounded p-3 max-w-[200px] text-center ${className ?? ''}`}
      >
        Payload too large for a QR code — use the link below instead.
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
    <div
      className={`cursor-pointer ${className ?? ''}`}
      style={{ display: 'inline-block' }}
      onClick={handleClick}
      title="Click to copy link"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
