import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MailProvider, SendMailInput } from '../mail-provider.interface';

const RESEND_API_URL = 'https://api.resend.com/emails';

export class ResendMailProvider implements MailProvider {
  private readonly logger = new Logger(ResendMailProvider.name);
  private readonly apiKey: string;
  private readonly from: string;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('RESEND_API_KEY')!.trim();
    this.from =
      config.get<string>('MAIL_FROM') ?? 'WES Console <onboarding@resend.dev>';
  }

  async send(input: SendMailInput): Promise<void> {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        html: input.html,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`Resend API error ${res.status}: ${body}`);
      throw new ServiceUnavailableException('Could not send email via Resend.');
    }

    this.logger.log(`Email sent via Resend to ${input.to}`);
  }
}
