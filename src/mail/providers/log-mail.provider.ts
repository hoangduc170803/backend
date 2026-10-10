import { Logger } from '@nestjs/common';
import type { MailProvider, SendMailInput } from '../mail-provider.interface';

/** No mail provider configured — logs what would have been sent instead of failing. */
export class LogMailProvider implements MailProvider {
  private readonly logger = new Logger(LogMailProvider.name);

  send(input: SendMailInput): Promise<void> {
    this.logger.warn(
      `No mail provider configured; email to ${input.to} not sent:\n${input.text}`,
    );
    return Promise.resolve();
  }
}
