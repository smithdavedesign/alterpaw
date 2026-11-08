// The daily jobs on the Cloudflare Worker: each Cron Trigger in wrangler.jsonc ("triggers.crons") runs one of
// app.js's job URLs, the same code Vercel Cron used to call over HTTP. The Worker's `scheduled` handler
// (src/worker.js) calls runScheduledJob, which sends the request straight to the app, inside the Worker.
//   SCHEDULED_JOBS                       cron expression → job path; test/worker.test.js checks wrangler.jsonc
//   runScheduledJob(app, cron, secret)   → { path, status, body }; throws if the job failed, so the run shows
//                                          as failed in Cloudflare's Cron Events. A 503 is a job that isn't
//                                          configured (gifts without email): skipped, not failed (app.js logs it)

// 04:00 UTC: photo deletion. 16:00 UTC: gifts, an hour that is local midnight nowhere, so a gift's delivery date
// has begun in every zone when the run comes (test/gift.test.js).
export const SCHEDULED_JOBS = {
  '0 4 * * *': '/jobs/expire-photos',
  '0 16 * * *': '/jobs/deliver-gifts',
};

// The host part is never resolved: app.fetch handles the request in this process.
const SCHEDULER_ORIGIN = 'https://scheduler.invalid';

export async function runScheduledJob(app, cron, cronSecret, { env, ctx } = {}) {
  const path = SCHEDULED_JOBS[cron];
  if (!path) throw new Error(`no job is scheduled for "${cron}"`);
  const request = new Request(`${SCHEDULER_ORIGIN}${path}`, { headers: { authorization: `Bearer ${cronSecret}` } });
  const res = await app.fetch(request, env, ctx);
  const body = await res.text();
  if (!res.ok && res.status !== 503) throw new Error(`${path} answered ${res.status}: ${body.slice(0, 200)}`);
  return { path, status: res.status, body };
}
