// Gift email, over Brevo's transactional API (free plan: 300 emails a day, one verified sender address, no
// domain needed). One REST call per email, no SDK.
//
//   createBrevoSender({ apiKey, from, fetch }) → ({ to, toName, subject, text, html }) => Promise<{ id }>
//
// The key is only ever sent in the api-key header. Errors carry a status code at most: never Brevo's error
// text, the key, or the recipient's address. `permanent` says whether sending the same message again could
// never work: only a 400 that names the recipient (a bad address). Other 400s, 401, 429, 5xx and network
// failures are our configuration or their outage, and are worth retrying.

export const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const SENDER_NAME = 'alterpaw';
const SEND_TIMEOUT_MS = 10_000;

export class EmailError extends Error {
  constructor(message, { permanent = false } = {}) {
    super(message);
    this.name = 'EmailError';
    this.permanent = permanent;
  }
}

// Brevo answers 400 (`invalid_parameter`) both for a recipient it won't send to ("email is not valid in to") and
// for our own setup, such as an unverified sender. Only the first can never work, so only it may cancel a paid gift;
// anything else is retried by the next run once the setup is fixed. Brevo's text is only matched, never logged
// (it can quote an address).
async function refusesRecipient(res) {
  try {
    const { message } = await res.json();
    return typeof message === 'string' && /\bin to\b/i.test(message);
  } catch {
    return false;
  }
}

export function createBrevoSender({ apiKey, from, fetch = globalThis.fetch, timeoutMs = SEND_TIMEOUT_MS }) {
  return async function sendEmail({ to, toName, subject, text, html }) {
    let res;
    try {
      res = await fetch(BREVO_URL, {
        method: 'POST',
        headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: { name: SENDER_NAME, email: from },
          to: [toName ? { email: to, name: toName } : { email: to }],
          subject,
          textContent: text,
          htmlContent: html,
          tags: ['gift'],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new EmailError(`brevo request failed: ${err?.name ?? 'Error'}`);
    }
    if (res.status === 400) {
      if (await refusesRecipient(res)) throw new EmailError('brevo responded 400 (the recipient address)', { permanent: true });
      throw new EmailError('brevo responded 400 (not about the recipient: check that EMAIL_FROM is a verified Brevo sender)');
    }
    if (!res.ok) throw new EmailError(`brevo responded ${res.status}`);
    let body;
    try {
      body = await res.json();
    } catch {
      body = {};
    }
    // Brevo has accepted the message by now; a missing id is not worth sending it twice.
    return { id: typeof body?.messageId === 'string' ? body.messageId : '' };
  };
}
