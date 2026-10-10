export interface SendMailInput {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface MailProvider {
  send(input: SendMailInput): Promise<void>;
}

export const MAIL_PROVIDER = Symbol('MAIL_PROVIDER');
