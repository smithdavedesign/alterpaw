import { makeApp, createPreview } from '../test/helpers.js';
const { app } = makeApp();
const slug = await createPreview(app);
const html = await (await app.request(`/p/${slug}`)).text();
console.log(html.slice(html.indexOf('<section class="share"'), html.indexOf('</main>')));
const expired = await (await app.request('/report', { method: 'POST', body: new URLSearchParams({ slug }), headers: { origin: 'http://localhost' } })).text();
console.log(expired.slice(expired.indexOf('<main'), expired.indexOf('</main>')));
