import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MAIL_PROVIDER, type MailProvider } from './mail-provider.interface';

interface PasswordResetMail {
  to: string;
  name?: string | null;
  link: string;
  subject?: string;
  intro?: string;
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

@Injectable()
export class MailService {
  private readonly appUrl: string;

  constructor(
    @Inject(MAIL_PROVIDER) private readonly provider: MailProvider,
    config: ConfigService,
  ) {
    this.appUrl = (
      config.get<string>('APP_URL') ??
      config.get<string>('WEB_ORIGIN') ??
      'http://localhost:5173'
    ).replace(/\/+$/, '');
  }

  passwordResetUrl(token: string): string {
    const url = new URL('/reset-password', `${this.appUrl}/`);
    url.searchParams.set('token', token);
    return url.toString();
  }

  async sendPasswordReset(mail: PasswordResetMail): Promise<void> {
    const safeName = escapeHtml(mail.name?.trim() || 'WES user');
    const safeLink = escapeHtml(mail.link);
    const intro =
      mail.intro ??
      'A password reset was requested for your WES Console account.';
    const subject = mail.subject ?? 'WES Console password reset';

    await this.provider.send({
      to: mail.to,
      subject,
      text: [
        `Hello ${mail.name?.trim() || 'WES user'},`,
        '',
        intro,
        'Open this link to set a new password:',
        mail.link,
        '',
        'This link expires soon. If you did not request this, you can ignore this email.',
      ].join('\n'),
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#14213d">
          <p>Hello ${safeName},</p>
          <p>${escapeHtml(intro)}</p>
          <p>
            <a href="${safeLink}" style="display:inline-block;padding:12px 18px;background:#3568ff;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">
              Reset password
            </a>
          </p>
          <p>If the button does not work, copy this link:</p>
          <p style="word-break:break-all;color:#475569">${safeLink}</p>
          <p style="color:#64748b;font-size:13px">This link expires soon. If you did not request this, you can ignore this email.</p>
        </div>
      `,
    });
  }
}
