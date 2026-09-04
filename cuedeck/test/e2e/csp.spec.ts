import { expect, test } from '@playwright/test';
import { launchApp, READY_SETTINGS } from './helpers';

// The renderer is loaded from index.html over file:// exactly as the packaged
// app does. Chromium ignores headers injected by onHeadersReceived for
// file:// loads, so the strict policy is stamped into the built index.html
// as a meta tag (vite.renderer.config.ts); this pins that it is present and
// enforced. DevTools-driven evaluation is exempt from CSP's eval rules, so the
// probe injects an inline <script> into the DOM instead, which is not.
test.describe('content security policy', () => {
  test('is enforced on the file:// renderer', async () => {
    const { app } = await launchApp({ seedSettings: READY_SETTINGS });
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('listen-button')).toBeVisible();
      expect(page.url().startsWith('file:')).toBe(true);
      const result = await page.evaluate(async () => {
        const w = window as never as { __cspProbe?: boolean };
        const violation = new Promise<string | null>((resolve) => {
          document.addEventListener(
            'securitypolicyviolation',
            (e) => resolve(e.violatedDirective),
            { once: true },
          );
          setTimeout(() => resolve(null), 1000);
        });
        const script = document.createElement('script');
        script.textContent = 'window.__cspProbe = true;';
        document.head.appendChild(script);
        script.remove();
        return {
          meta:
            document
              .querySelector('meta[http-equiv="Content-Security-Policy"]')
              ?.getAttribute('content') ?? null,
          inlineScriptRan: w.__cspProbe === true,
          violatedDirective: await violation,
        };
      });
      expect(result.meta).toContain("default-src 'none'");
      expect(result.meta).toContain("script-src 'self'");
      expect(result.inlineScriptRan).toBe(false);
      expect(result.violatedDirective).toBe('script-src-elem');
    } finally {
      await app.close();
    }
  });
});
