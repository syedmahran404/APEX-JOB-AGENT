// ScreenshotManager — captures a Page screenshot, blurs sensitive fields
// before persistence (audit Phase 6 §12), uploads to object storage, and
// records a row in `screenshots`.
//
// Phase 2 implementation:
//   - Field redaction is done with an `addStyleTag` that paints a black box
//     over each sensitive selector. We then take the screenshot, then
//     remove the style tag. This gives us a single-pass redaction without
//     modifying the page's actual DOM.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Page } from 'playwright';
import type { Logger } from '@apex/shared-logger';
import type { ScreenshotRepository } from '@apex/db';
import type { ScreenshotManager } from './interfaces.js';
import type { ObjectStore } from './session-manager.js';
import { newUlid } from '../utils/ulid.js';

export interface DefaultScreenshotManagerOptions {
  logger: Logger;
  store: ObjectStore;
  prefix: string;
  screenshotRepo: ScreenshotRepository;
}

export class DefaultScreenshotManager implements ScreenshotManager {
  private readonly logger: Logger;
  constructor(private readonly opts: DefaultScreenshotManagerOptions) {
    this.logger = opts.logger.child({ component: 'screenshot-manager' });
  }

  async capture(input: {
    page: Page;
    userId: string;
    tenantId: string;
    applicationId?: string | null;
    runId?: string | null;
    platformId?: string | null;
    label: string;
    sensitiveSelectors?: ReadonlyArray<string>;
  }): Promise<{ uri: string; redacted: boolean }> {
    const tmp = path.join(os.tmpdir(), `apex-screenshot-${newUlid()}.png`);
    let redacted = false;
    let styleHandle: string | null = null;

    try {
      // Apply redaction overlay.
      if (input.sensitiveSelectors && input.sensitiveSelectors.length > 0) {
        const css = input.sensitiveSelectors
          .map(
            (sel) =>
              `${sel} { background: #000 !important; color: #000 !important; -webkit-text-security: disc !important; }`,
          )
          .join('\n');
        try {
          await input.page.addStyleTag({ content: css });
          redacted = true;
          styleHandle = 'applied';
        } catch (err) {
          this.logger.warn({ err }, 'failed to apply redaction CSS — proceeding without');
        }
      }

      await input.page.screenshot({ path: tmp, fullPage: false, type: 'png' });

      const key = `${this.opts.prefix.replace(/\/$/, '')}/${input.tenantId}/${input.userId}/${newUlid()}.png`;
      const uri = await this.opts.store.putFile(tmp, key, { contentType: 'image/png' });

      // Persist DB row.
      const stat = await fs.stat(tmp);
      await this.opts.screenshotRepo.create({
        tenantId: input.tenantId,
        userId: input.userId,
        applicationId: input.applicationId ?? null,
        runId: input.runId ?? null,
        platformId: input.platformId ?? null,
        kind: 'apply',
        uri,
        redacted,
        bytes: BigInt(stat.size),
        sha256: null,
        label: input.label,
      });

      return { uri, redacted };
    } finally {
      // Reverse the style overlay so subsequent steps see the original layout.
      if (styleHandle !== null) {
        try {
          await input.page.evaluate(() => {
            // Remove the last-added <style>; addStyleTag appends to head.
            const last = document.head.querySelector('style:last-of-type');
            last?.remove();
          });
        } catch (err) {
          this.logger.warn({ err }, 'failed to reverse redaction CSS');
        }
      }
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }
}
