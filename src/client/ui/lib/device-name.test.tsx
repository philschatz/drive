/**
 * Unit tests for the default device-name generator. Runs under the jsdom
 * (`ui`) jest project so `navigator` exists; we stub userAgent / userAgentData
 * per case. Named `.test.tsx` so the node (`server`) project skips it.
 */

import { detectBrowserName, detectDeviceKind, generateDefaultDeviceName } from './device-name';

const origUA = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');

function setNav(ua: string, uaData?: unknown) {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
  (window.navigator as any).userAgentData = uaData;
}

afterEach(() => {
  if (origUA) Object.defineProperty(window.navigator, 'userAgent', origUA);
  delete (window.navigator as any).userAgentData;
});

const UAS = {
  chromeDesktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  firefoxDesktop: 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
  edgeDesktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  operaDesktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0',
  safariDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  safariIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  chromeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1',
  firefoxIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/121.0 Mobile/15E148 Safari/604.1',
  samsung: 'Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
};

describe('detectBrowserName', () => {
  it.each([
    ['chromeDesktop', 'Chrome'],
    ['firefoxDesktop', 'Firefox'],
    ['edgeDesktop', 'Edge'],
    ['operaDesktop', 'Opera'],
    ['safariDesktop', 'Safari'],
    ['chromeAndroid', 'Chrome'],
    ['safariIos', 'Safari'],
    ['chromeIos', 'Chrome'],
    ['firefoxIos', 'Firefox'],
    ['samsung', 'Samsung Internet'],
  ])('%s → %s', (key, expected) => {
    setNav(UAS[key as keyof typeof UAS]);
    expect(detectBrowserName()).toBe(expected);
  });

  it('prefers userAgentData brands over the UA string', () => {
    // Bogus UA; brands should win.
    setNav('Mozilla/5.0 nonsense', { mobile: false, brands: [{ brand: 'Chromium', version: '120' }, { brand: 'Google Chrome', version: '120' }] });
    expect(detectBrowserName()).toBe('Chrome');
  });

  it('falls back to "Browser" for an unrecognized UA', () => {
    setNav('SomeRandomBot/1.0');
    expect(detectBrowserName()).toBe('Browser');
  });
});

describe('detectDeviceKind', () => {
  it.each([
    ['chromeDesktop', 'laptop'],
    ['firefoxDesktop', 'laptop'],
    ['safariDesktop', 'laptop'],
    ['chromeAndroid', 'phone'],
    ['safariIos', 'phone'],
    ['samsung', 'phone'],
  ])('%s → %s', (key, expected) => {
    setNav(UAS[key as keyof typeof UAS]);
    expect(detectDeviceKind()).toBe(expected);
  });

  it('uses userAgentData.mobile when present', () => {
    setNav('Mozilla/5.0 (Windows NT 10.0) Chrome/120', { mobile: true, brands: [] });
    expect(detectDeviceKind()).toBe('phone');
  });
});

describe('generateDefaultDeviceName', () => {
  it('combines the kind emoji and browser name', () => {
    setNav(UAS.firefoxDesktop);
    expect(generateDefaultDeviceName()).toBe('💻 Firefox');
    setNav(UAS.chromeAndroid);
    expect(generateDefaultDeviceName()).toBe('📱 Chrome');
  });
});
