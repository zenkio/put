import { spawn } from 'child_process';
import { EMAIL_CHANNEL } from './config.js';
import { isEmailProcessed, markEmailProcessed, markEmailResponded } from './db.js';
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

export interface EmailMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  body: string;
  date: string;
}

/**
 * Call Gmail MCP tool via subprocess
 */
async function callGmailMcp(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['-y', '@gongrzhe/server-gmail-autoauth-mcp'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Gmail MCP failed: ${stderr}`));
        return;
      }

      try {
        // Parse MCP response (JSON-RPC format)
        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            const response = JSON.parse(line);
            if (response.result) {
              resolve(response.result);
              return;
            }
            if (response.error) {
              reject(new Error(response.error.message || 'MCP error'));
              return;
            }
          }
        }
        resolve(null);
      } catch (err) {
        reject(new Error(`Failed to parse MCP response: ${err}`));
      }
    });

    // Send MCP request
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args
      }
    };

    proc.stdin.write(JSON.stringify(request) + '\n');
    proc.stdin.end();
  });
}

export async function checkForNewEmails(): Promise<EmailMessage[]> {
  try {
    // Build query based on trigger mode
    let query: string;
    switch (EMAIL_CHANNEL.triggerMode) {
      case 'label':
        query = `label:${EMAIL_CHANNEL.triggerValue} is:unread`;
        break;
      case 'address':
        query = `to:${EMAIL_CHANNEL.triggerValue} is:unread`;
        break;
      case 'subject':
        query = `subject:"${EMAIL_CHANNEL.triggerValue}" is:unread`;
        break;
    }

    logger.debug({ query }, 'Searching for emails');

    // Call Gmail MCP search_emails tool
    const result = await callGmailMcp('mcp__gmail__search_emails', {
      query,
      maxResults: 10
    }) as { emails?: Array<{ id: string; threadId: string; from: string; subject: string; snippet: string; date: string }> };

    if (!result || !result.emails || result.emails.length === 0) {
      return [];
    }

    // Fetch full content for each email
    const emails: EmailMessage[] = [];
    for (const email of result.emails) {
      // Skip already processed
      if (isEmailProcessed(email.id)) {
        logger.debug({ id: email.id }, 'Email already processed, skipping');
        continue;
      }

      try {
        // Get full email content
        const fullEmail = await callGmailMcp('mcp__gmail__get_email', {
          id: email.id
        }) as { id: string; threadId: string; from: string; subject: string; body: string; date: string };

        if (fullEmail && fullEmail.body) {
          emails.push({
            id: fullEmail.id,
            threadId: fullEmail.threadId,
            from: fullEmail.from,
            subject: fullEmail.subject,
            body: fullEmail.body,
            date: fullEmail.date
          });
        }
      } catch (err) {
        logger.error({ err, emailId: email.id }, 'Failed to fetch full email');
      }
    }

    return emails;
  } catch (err) {
    logger.error({ err }, 'Failed to check emails');
    return [];
  }
}

export async function sendEmailReply(
  threadId: string,
  to: string,
  subject: string,
  body: string
): Promise<void> {
  try {
    // Prefix subject with Re: if not already
    const replySubject = subject.startsWith('Re:')
      ? subject
      : `Re: ${subject}`;

    // Add prefix to body if configured
    const prefixedBody = EMAIL_CHANNEL.replyPrefix
      ? `${EMAIL_CHANNEL.replyPrefix}\n\n${body}`
      : body;

    logger.debug({ to, subject: replySubject }, 'Sending email reply');

    await callGmailMcp('mcp__gmail__send_email', {
      to,
      subject: replySubject,
      body: prefixedBody,
      threadId  // Include threadId to keep it in the same conversation
    });

    logger.info({ to, subject: replySubject }, 'Email sent');
  } catch (err) {
    logger.error({ err, to, subject }, 'Failed to send email');
    throw err;
  }
}

export function getContextKey(email: EmailMessage): string {
  switch (EMAIL_CHANNEL.contextMode) {
    case 'thread':
      return `email-thread-${email.threadId}`;
    case 'sender':
      // Normalize email address to lowercase for consistency
      const senderEmail = email.from.toLowerCase().match(/<(.+)>/)?.[1] || email.from.toLowerCase();
      return `email-sender-${senderEmail.replace(/[^a-z0-9@.-]/g, '_')}`;
    case 'single':
      return 'email-main';
  }
}
