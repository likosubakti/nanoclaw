import type { BrowserWindow } from 'electron';
import { app } from 'electron';

/**
 * Startup self-check, enabled with GLM_STUDIO_SMOKE=1.
 *
 * Verifies the things a typecheck cannot: that the preload bridge attached,
 * that the CSP did not block the renderer bundle, and that the shell actually
 * mounted. Used by CI and by `scripts/smoke.mjs`, and useful for confirming a
 * from-source install works before wiring up the launcher.
 */
export function runSmokeCheck(window: BrowserWindow): void {
  if (process.env.GLM_STUDIO_SMOKE !== '1') return;

  const fail = (reason: string) => {
    process.stdout.write(`SMOKE_FAIL ${reason}\n`);
    app.exit(1);
  };

  const timer = setTimeout(() => fail('renderer did not mount within 30s'), 30_000);

  window.webContents.once('did-finish-load', () => {
    // Give the async boot() a moment to populate the shell.
    setTimeout(async () => {
      try {
        const report = await window.webContents.executeJavaScript(`
          (() => {
            const root = document.getElementById('root');
            return {
              bridge: typeof window.glm === 'object',
              sidebar: !!root?.querySelector('.sidebar'),
              composer: !!root?.querySelector('.composer textarea'),
              chips: root?.querySelectorAll('.status-chip').length ?? 0,
            };
          })()
        `);

        clearTimeout(timer);
        if (!report.bridge) return fail('preload bridge missing');
        if (!report.sidebar) return fail('shell did not render');
        if (!report.composer) return fail('chat composer did not render');
        if (report.chips < 3) return fail(`expected 3 provider chips, saw ${report.chips}`);

        process.stdout.write('SMOKE_OK\n');
        app.exit(0);
      } catch (err) {
        clearTimeout(timer);
        fail((err as Error).message);
      }
    }, 2500);
  });
}
