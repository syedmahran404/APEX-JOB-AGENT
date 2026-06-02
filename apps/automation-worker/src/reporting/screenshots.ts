// Screenshot capture + upload. The worker captures a PNG via the DriverPage
// (with sensitive regions masked), builds metadata via automation-core, and
// hands it to an ArtifactStore (S3). The metadata reference is what the
// orchestrator persists / the dashboard renders.
//
// Reference: docs/architecture/06-automation-engine.md §7, §13.

import {
  buildScreenshotMetadata,
  type ScreenshotMetadata,
  type ScreenshotReason,
} from '@apex/automation-core';
import type { DriverPage } from '../browser/driver.js';

/** Uploads screenshot bytes; returns nothing (key already known from metadata). */
export interface ArtifactStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<{ sha256: string }>;
}

export interface ScreenshotCapturerDeps {
  store: ArtifactStore;
  clock: () => Date;
  /** Sensitive selectors masked before the pixels are captured. */
  sensitiveSelectors: string[];
}

export interface CaptureRequest {
  page: DriverPage;
  reason: ScreenshotReason;
  runId: string;
  userId: string;
  platformKey: string;
  label: string;
  applicationId?: string | undefined;
  seq: number;
}

export class ScreenshotCapturer {
  constructor(private readonly deps: ScreenshotCapturerDeps) {}

  /**
   * Capture (with sensitive selectors masked), build metadata, upload, and
   * return the persisted metadata (incl. content hash). Masking happens at
   * capture time so raw secrets never reach the bytes.
   */
  async capture(req: CaptureRequest): Promise<ScreenshotMetadata> {
    const meta = buildScreenshotMetadata({
      reason: req.reason,
      runId: req.runId,
      userId: req.userId,
      platformKey: req.platformKey,
      label: req.label,
      applicationId: req.applicationId,
      capturedAt: this.deps.clock(),
      sensitiveSelectors: this.deps.sensitiveSelectors,
      seq: req.seq,
    });
    const bytes = await req.page.screenshot({ maskSelectors: meta.sensitiveSelectors });
    const { sha256 } = await this.deps.store.put(meta.storageKey, bytes, 'image/png');
    return { ...meta, sha256 };
  }
}
