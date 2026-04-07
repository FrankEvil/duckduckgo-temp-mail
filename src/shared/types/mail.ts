export type MailSummary = {
  id: string;
  address: string;
  from: string;
  sourceAddress?: string;
  recipientAddress?: string;
  subject: string;
  receivedAt: string;
  preview: string;
  content?: string;
  htmlContent?: string;
  inlineResourceMap?: Record<string, string>;
  raw?: string;
};
