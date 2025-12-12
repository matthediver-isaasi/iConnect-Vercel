import Mailgun from 'mailgun.js';
import formData from 'form-data';

const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN || 'mail.iconn.app';
const DEFAULT_FROM = process.env.MAILGUN_FROM_EMAIL || 'ICONN <noreply@mail.iconn.app>';
const MAILGUN_REGION = process.env.MAILGUN_REGION || 'eu';

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
}

interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

let mailgunClient: any = null;

function getMailgunClient() {
  if (!mailgunClient && MAILGUN_API_KEY) {
    const mailgun = new Mailgun(formData);
    const config: any = {
      username: 'api',
      key: MAILGUN_API_KEY,
    };
    
    if (MAILGUN_REGION === 'eu') {
      config.url = 'https://api.eu.mailgun.net';
    }
    
    mailgunClient = mailgun.client(config);
  }
  return mailgunClient;
}

export async function sendEmail(options: EmailOptions): Promise<EmailResult> {
  const { to, subject, html, text, from = DEFAULT_FROM } = options;

  if (!MAILGUN_API_KEY) {
    console.error('[Email Service] MAILGUN_API_KEY not configured');
    return {
      success: false,
      error: 'Email service not configured - missing API key',
    };
  }

  const client = getMailgunClient();
  if (!client) {
    return {
      success: false,
      error: 'Failed to initialize Mailgun client',
    };
  }

  try {
    console.log(`[Email Service] Sending email to: ${to}`);
    console.log(`[Email Service] Subject: ${subject}`);

    const messageData = {
      from,
      to: [to],
      subject,
      html,
      text: text || html.replace(/<[^>]*>/g, ''),
    };

    const response = await client.messages.create(MAILGUN_DOMAIN, messageData);

    console.log(`[Email Service] Email sent successfully. Message ID: ${response.id}`);

    return {
      success: true,
      messageId: response.id,
    };
  } catch (error: any) {
    console.error('[Email Service] Failed to send email:', error.message || error);
    return {
      success: false,
      error: error.message || 'Unknown error sending email',
    };
  }
}

export function isEmailServiceConfigured(): boolean {
  return !!MAILGUN_API_KEY;
}
