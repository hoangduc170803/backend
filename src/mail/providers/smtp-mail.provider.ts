import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import type { MailProvider, SendMailInput } from '../mail-provider.interface';

export class SmtpMailProvider implements MailProvider {
  private readonly logger = new Logger(SmtpMailProvider.name);
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: ConfigService) {
    const host = config.get<string>('SMTP_HOST')!.trim();
    const port = Number(config.get<string>('SMTP_PORT', '587'));
    const user = config.get<string>('SMTP_USER')?.trim();
    const pass = config.get<string>('SMTP_PASS');
    const secureEnv = config.get<string>('SMTP_SECURE')?.toLowerCase();
    const secure = secureEnv ? secureEnv === 'true' : port === 465;
    const rejectUnauthorizedEnv = config
      .get<string>('SMTP_TLS_REJECT_UNAUTHORIZED')
      ?.toLowerCase();
    const rejectUnauthorized = rejectUnauthorizedEnv !== 'false';

    this.from =
      config.get<string>('MAIL_FROM') ??
      (user ? `WES Console <${user}>` : 'WES Console <no-reply@localhost>');
    this.transporter = createTransport({
      host,
      port,
      secure,
      auth: user && pass ? { user, pass } : undefined,
      tls: { rejectUnauthorized },
    });
  }

  async send(input: SendMailInput): Promise<void> {
    try {
      await this.transporter.sendMail({ from: this.from, ...input });
      this.logger.log(`Email sent via SMTP to ${input.to}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to send email to ${input.to}: ${detail}`);
      throw new ServiceUnavailableException('Could not send email via SMTP.');
    }
  }
}
