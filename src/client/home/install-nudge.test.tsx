import { detectMobilePlatform, installInstructions } from './install-nudge';

const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
  ipad:
    'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36',
  androidFirefox:
    'Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0',
  desktopFirefox:
    'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  desktopChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};

describe('detectMobilePlatform', () => {
  it('detects iOS devices', () => {
    expect(detectMobilePlatform(UA.iphoneSafari)).toBe('ios');
    expect(detectMobilePlatform(UA.iphoneChrome)).toBe('ios');
    expect(detectMobilePlatform(UA.ipad)).toBe('ios');
  });

  it('detects Android devices', () => {
    expect(detectMobilePlatform(UA.androidChrome)).toBe('android');
    expect(detectMobilePlatform(UA.androidFirefox)).toBe('android');
  });

  it('returns null for desktop browsers', () => {
    expect(detectMobilePlatform(UA.desktopFirefox)).toBeNull();
    expect(detectMobilePlatform(UA.desktopChrome)).toBeNull();
  });
});

describe('installInstructions', () => {
  it('gives Safari the Share-button flow on iOS', () => {
    expect(installInstructions('Safari', 'ios')).toContain('Share button');
    expect(installInstructions('Safari', 'ios')).toContain('Add to Home Screen');
  });

  it('gives non-Safari iOS browsers the address-bar Share flow', () => {
    for (const browser of ['Chrome', 'Firefox', 'Edge']) {
      expect(installInstructions(browser, 'ios')).toContain('Share icon in the address bar');
    }
  });

  it('gives each Android browser its own menu wording', () => {
    expect(installInstructions('Chrome', 'android')).toContain('"Add to Home screen" or "Install app"');
    expect(installInstructions('Firefox', 'android')).toContain('Add app to Home screen');
    expect(installInstructions('Samsung Internet', 'android')).toContain('Add page to');
    expect(installInstructions('Edge', 'android')).toContain('Add to phone');
    expect(installInstructions('Opera', 'android')).toContain('"Add to" → "Home screen"');
  });

  it('falls back to generic wording for unknown browsers', () => {
    expect(installInstructions('Browser', 'android')).toContain(
      '"Add to Home screen" or "Install app" menu option',
    );
  });

  it('always explains why (Install this app prefix)', () => {
    for (const [browser, platform] of [
      ['Safari', 'ios'],
      ['Chrome', 'android'],
      ['Browser', 'android'],
    ] as const) {
      expect(installInstructions(browser, platform)).toMatch(/^Install this app: /);
    }
  });
});
