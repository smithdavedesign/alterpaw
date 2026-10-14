// M4: the Brevo client that sends gift emails.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createBrevoSender, EmailError, BREVO_URL } from '../src/email.js';
import { fakeBrevoKey } from './helpers.js';

const message = { to: 'jamie@example.com', toName: 'Jamie', subject: 'A gift from Sam', text: 'Hi Jamie', html: '<p>Hi Jamie</p>' };

function brevoFetch(respond) {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, init });
    return respond(url, init);
  };
  return { fetch, seen };
}

describe('the Brevo client', () => {
  test('sends one transactional email from the verified sender, with the key in the api-key header only', async () => {
    const key = fakeBrevoKey();
    const { fetch, seen } = brevoFetch(() => Response.json({ messageId: '<202610200400.1@smtp-relay.mailin.fr>' }, { status: 201 }));
    const send = createBrevoSender({ apiKey: key, from: 'gifts@alterpaw.example', fetch });
    assert.deepEqual(await send(message), { id: '<202610200400.1@smtp-relay.mailin.fr>' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, BREVO_URL);
    assert.equal(BREVO_URL, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(seen[0].init.method, 'POST');
    assert.equal(seen[0].init.headers['api-key'], key);
    assert.equal(seen[0].init.headers['content-type'], 'application/json');
    assert.equal(seen[0].init.headers.accept, 'application/json');
    assert.ok(seen[0].init.signal, 'the request has a timeout');
    assert.ok(!seen[0].init.body.includes(key), 'the key is not in the body');
    assert.deepEqual(JSON.parse(seen[0].init.body), {
      sender: { name: 'alterpaw', email: 'gifts@alterpaw.example' },
      to: [{ email: 'jamie@example.com', name: 'Jamie' }],
      subject: 'A gift from Sam',
      textContent: 'Hi Jamie',
      htmlContent: '<p>Hi Jamie</p>',
      tags: ['gift'],
    });
  });

  test('a recipient without a name is sent without one', async () => {
    const { fetch, seen } = brevoFetch(() => Response.json({ messageId: 'x' }, { status: 201 }));
    await createBrevoSender({ apiKey: fakeBrevoKey(), from: 'gifts@alterpaw.example', fetch })({ ...message, toName: '' });
    assert.deepEqual(JSON.parse(seen[0].init.body).to, [{ email: 'jamie@example.com' }]);
  });

  test('failures are EmailErrors without the key: a 400 about the recipient is permanent; the rest can be retried', async () => {
    const key = fakeBrevoKey();
    const cases = [
      // Brevo's answer for a recipient it won't send to: retrying can't help, so the gift is cancelled and refunded.
      [() => Response.json({ code: 'invalid_parameter', message: 'email is not valid in to' }, { status: 400 }), true],
      // A 400 about our own setup (an unverified EMAIL_FROM, or a field we got wrong) must not cancel paid gifts:
      // once it's fixed, the next run sends them.
      [
        () =>
          Response.json(
            { code: 'invalid_parameter', message: 'Sending has been rejected because the sender you used gifts@alterpaw.example is not valid. Validate your sender or authenticate your domain' },
            { status: 400 },
          ),
        false,
      ],
      [() => Response.json({ code: 'missing_parameter', message: 'subject is missing' }, { status: 400 }), false],
      [() => new Response('<html>Bad Request</html>', { status: 400 }), false],
      [() => Response.json({ code: 'unauthorized', message: `Key not found: ${key}` }, { status: 401 }), false],
      [() => new Response('rate limited', { status: 429 }), false],
      [() => new Response('upstream', { status: 503 }), false],
      [
        () => {
          throw new TypeError(`fetch failed ${key}`);
        },
        false,
      ],
    ];
    for (const [i, [respond, permanent]] of cases.entries()) {
      await assert.rejects(createBrevoSender({ apiKey: key, from: 'gifts@alterpaw.example', fetch: brevoFetch(respond).fetch })(message), (err) => {
        assert.ok(err instanceof EmailError, `case ${i}`);
        assert.equal(err.permanent, permanent, `case ${i}`);
        assert.ok(!err.message.includes(key), `case ${i}: no key in the message`);
        assert.ok(!err.message.includes('jamie@example.com'), `case ${i}: no address in the message`);
        assert.ok(!err.message.includes('gifts@alterpaw.example'), `case ${i}: Brevo's text is never repeated`);
        return true;
      });
    }
  });
});
