import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PUSH_SWEEP_SECONDS, loadPushSettings } from './push-config';
import { PushSenderService } from './push-sender.service';

/**
 * Runs the sender on a timer, in every hub instance. The instances need no
 * agreement between them: every step of the sender is claimed in the database
 * (see PushSenderService). With PUSH_ENABLED off a tick is a single env read.
 */
@Injectable()
export class PushSweepService implements OnModuleInit {
  private readonly logger = new Logger(PushSweepService.name);

  constructor(private readonly sender: PushSenderService) {}

  /**
   * A base URL that IS set is checked at boot (anything but Expo's own host,
   * or a local address, stops the server), like Fintava's. Says once whether
   * this instance pushes.
   */
  onModuleInit(): void {
    const settings = loadPushSettings();
    this.logger.log(
      settings.on
        ? 'Phone push is ON for this server.'
        : 'Phone push is off (PUSH_ENABLED is not true): nothing is sent to Expo.',
    );
  }

  @Interval('push-sweep', PUSH_SWEEP_SECONDS * 1000)
  async tick(): Promise<void> {
    try {
      const report = await this.sender.runOnce();
      if (report.sent + report.failed + report.delivered + report.skipped > 0) {
        this.logger.log(
          `Push pass: ${report.sent} sent, ${report.delivered} delivered, ${report.skipped} skipped, ${report.failed} failed, ${report.retried} to retry.`,
        );
      }
    } catch (error) {
      this.logger.error(
        'Push tick failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
