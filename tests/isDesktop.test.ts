import test from 'node:test';
import assert from 'node:assert/strict';
import { detectIosSafari, type UaSignals } from '../src/lib/isDesktop';

// UA strings captured from real browsers. The routing decision in
// App.tsx's handleLogin depends on these exact shapes: plain iOS Safari
// takes the full-page /desktop-auth flow, everything else keeps the
// Firebase popup flow.
const signals = (
  userAgent: string,
  platform = '',
  maxTouchPoints = 0,
): UaSignals => ({ userAgent, platform, maxTouchPoints });

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IPAD_SAFARI =
  'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const MAC_SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0.6312.52 Mobile/15E148 Safari/604.1';
const IPHONE_FIREFOX =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/124.0 Mobile/15E148 Safari/605.1.15';
const IPHONE_EDGE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/123.0.2420.51 Version/17.0 Mobile/15E148 Safari/605.1.15';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36';
const WINDOWS_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

test('detectIosSafari: iPhone Safari → true', () => {
  assert.equal(detectIosSafari(signals(IPHONE_SAFARI, 'iPhone', 5)), true);
});

test('detectIosSafari: iPad Safari (UA có token iPad) → true', () => {
  assert.equal(detectIosSafari(signals(IPAD_SAFARI, 'iPad', 5)), true);
});

test('detectIosSafari: iPadOS giả Mac (MacIntel + cảm ứng) → true', () => {
  assert.equal(detectIosSafari(signals(MAC_SAFARI_UA, 'MacIntel', 5)), true);
});

test('detectIosSafari: Safari trên Mac thật (không cảm ứng) → false', () => {
  assert.equal(detectIosSafari(signals(MAC_SAFARI_UA, 'MacIntel', 0)), false);
});

test('detectIosSafari: Chrome/Firefox/Edge trên iPhone → false dù UA vẫn chứa Safari', () => {
  assert.equal(detectIosSafari(signals(IPHONE_CHROME, 'iPhone', 5)), false);
  assert.equal(detectIosSafari(signals(IPHONE_FIREFOX, 'iPhone', 5)), false);
  assert.equal(detectIosSafari(signals(IPHONE_EDGE, 'iPhone', 5)), false);
});

test('detectIosSafari: Android và Windows → false', () => {
  assert.equal(detectIosSafari(signals(ANDROID_CHROME, 'Linux armv8l', 5)), false);
  assert.equal(detectIosSafari(signals(WINDOWS_CHROME, 'Win32', 0)), false);
});

test('detectIosSafari: UA rỗng → false', () => {
  assert.equal(detectIosSafari(signals('', '', 0)), false);
});
