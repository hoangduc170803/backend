import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MailService } from './mail.service';
import { MAIL_PROVIDER, type MailProvider } from './mail-provider.interface';
import { SmtpMailProvider } from './providers/smtp-mail.provider';
import { ResendMailProvider } from './providers/resend-mail.provider';
import { LogMailProvider } from './providers/log-mail.provider';

function resolveProviderName(config: ConfigService): string {
  const explicit = config.get<string>('MAIL_PROVIDER')?.trim().toLowerCase();
  if (explicit) return explicit;
  if (config.get<string>('RESEND_API_KEY')?.trim()) return 'resend';
  if (config.get<string>('SMTP_HOST')?.trim()) return 'smtp';
  return 'log';
}

@Module({
  imports: [ConfigModule],
  providers: [
    MailService,
    {
      provide: MAIL_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): MailProvider => {
        switch (resolveProviderName(config)) {
          case 'resend':
            return new ResendMailProvider(config);
          case 'smtp':
            return new SmtpMailProvider(config);
          default:
            return new LogMailProvider();
        }
      },
    },
  ],
  exports: [MailService],
})
export class MailModule {}
