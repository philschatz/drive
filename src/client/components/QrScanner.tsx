/**
 * QrScanner — a full-screen camera overlay that decodes a QR code and reports its
 * text via onResult. Uses the native BarcodeDetector API where available (Chrome /
 * Android: fast, zero cost) and falls back to the jsQR library elsewhere (iOS Safari,
 * Firefox). The camera stream is torn down on unmount, close, or first result so the
 * camera indicator turns off.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import jsQR from 'jsqr';
import { Button } from '@/components/ui/button';

interface QrScannerProps {
  onResult: (text: string) => void;
  onClose: () => void;
}

// BarcodeDetector is not in TS's lib DOM yet; describe just what we use.
interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<Array<{ rawValue: string }>>;
}
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

export function QrScanner({ onResult, onClose }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let stream: MediaStream | null = null;
    let rafId = 0;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const teardown = () => {
      stopped = true;
      if (rafId) cancelAnimationFrame(rafId);
      stream?.getTracks().forEach(t => t.stop());
    };

    const finish = (text: string) => {
      if (stopped) return;
      teardown();
      onResult(text);
    };

    const start = async () => {
      if (!window.isSecureContext) {
        setError('Camera access requires a secure connection (HTTPS or localhost).');
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Camera is not available in this browser.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
      } catch (err: any) {
        if (err?.name === 'NotAllowedError') setError('Camera permission denied.');
        else if (err?.name === 'NotFoundError') setError('No camera found on this device.');
        else setError('Could not open the camera: ' + (err?.message ?? String(err)));
        return;
      }
      if (stopped) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => {});

      const Detector = (window as any).BarcodeDetector as BarcodeDetectorCtor | undefined;
      let detector: BarcodeDetectorLike | null = null;
      try {
        if (Detector) detector = new Detector({ formats: ['qr_code'] });
      } catch {
        detector = null; // exposed but unusable — fall back to jsQR
      }

      const scan = async () => {
        if (stopped) return;
        if (video.readyState >= 2 && video.videoWidth > 0) {
          try {
            if (detector) {
              const codes = await detector.detect(video);
              if (codes[0]?.rawValue) return finish(codes[0].rawValue);
            } else if (ctx) {
              canvas.width = video.videoWidth;
              canvas.height = video.videoHeight;
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const code = jsQR(data, width, height);
              if (code?.data) return finish(code.data);
            }
          } catch {
            // transient decode/detect errors — keep scanning
          }
        }
        rafId = requestAnimationFrame(scan);
      };
      rafId = requestAnimationFrame(scan);
    };

    start();
    return teardown;
    // onResult is stable per the caller; we only want this to run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="max-h-full max-w-full object-contain"
      />

      {/* Viewfinder framing guide */}
      {!error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-56 w-56 rounded-lg border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.4)]" />
        </div>
      )}

      {error ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
          <p className="text-sm text-white">{error}</p>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      ) : (
        <>
          <p className="absolute top-6 left-0 right-0 text-center text-sm text-white/90">
            Point the camera at a QR code
          </p>
          <Button
            variant="outline"
            size="icon"
            className="absolute top-4 right-4"
            aria-label="Close scanner"
            onClick={onClose}
          >
            <span className="material-symbols-outlined">close</span>
          </Button>
        </>
      )}
    </div>
  );
}
