// Go-live: what search engines and link previews see, and the RepoHQ visit beacon.
//   PUBLIC_PAGES      the indexable pages, each with its own title and description; the sitemap lists them
//   siteUrlFromEnv    the canonical origin, from Vercel's VERCEL_PROJECT_PRODUCTION_URL (null: use the request's)
//   robotsTxt, sitemapXml, softwareApplication (JSON-LD), OG_IMAGE (drawn by share.js)
//   BEACON_SCRIPT     /beacon.js; the page loads it on the production deployment only (app.js)
// Only fixed text and the origin go into any of this, never user text.
import { PRODUCTS } from './payments.js';

export const SITE_NAME = 'alterpaw';
export const REPO_URL = 'https://github.com/smithdavedesign/alterpaw';
export const ISSUES_URL = `${REPO_URL}/issues`;

export const PUBLIC_PAGES = {
  home: {
    path: '/',
    title: "alterpaw — your pet's secret life, exposed",
    description:
      'Upload one photo of your dog or cat, pick an alter ego, and get a funny wanted poster, newspaper front page, trading card and bio starring your real pet. Free preview.',
  },
  privacy: {
    path: '/privacy',
    title: 'Privacy — alterpaw',
    description:
      'What alterpaw stores and for how long, who processes it, the three anonymous usage signals it sends, and why it sets no cookies.',
  },
  terms: {
    path: '/terms',
    title: 'Terms and refunds — alterpaw',
    description:
      'The terms for using alterpaw: AI-written parody, photos you have the right to use, the paid bundle, gifts and printed posters, refunds, and no warranty.',
  },
};

// The link-preview image (Open Graph, Twitter), drawn with code in share.js.
export const OG_IMAGE = {
  path: '/og.png',
  width: 1200,
  height: 630,
  alt: "alterpaw: a wanted poster for your pet, with the headline \"Your pet's secret life, exposed.\"",
};

// Vercel sets this to the project's production domain (the shortest custom domain, else the vercel.app one),
// without a scheme. Anything that isn't a plain host name is ignored and the request's origin is used.
const HOST_NAME = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
export function siteUrlFromEnv(env) {
  const host = env.VERCEL_PROJECT_PRODUCTION_URL;
  return typeof host === 'string' && HOST_NAME.test(host) ? `https://${host.toLowerCase()}` : null;
}

// Previews (/p/…) aren't disallowed on purpose: a crawler must fetch them to see their noindex.
export const robotsTxt = (origin) => `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`;

const xmlText = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const sitemapXml = (origin) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${Object.values(PUBLIC_PAGES)
  .map(({ path }) => `  <url><loc>${xmlText(`${origin}${path}`)}</loc></url>`)
  .join('\n')}
</urlset>
`;

const dollars = (cents) => (cents / 100).toFixed(2);
export function softwareApplication(origin) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE_NAME,
    url: `${origin}/`,
    description: PUBLIC_PAGES.home.description,
    image: `${origin}${OG_IMAGE.path}`,
    applicationCategory: 'EntertainmentApplication',
    operatingSystem: 'Any (web browser)',
    offers: [
      { '@type': 'Offer', name: 'Watermarked preview', price: '0', priceCurrency: 'USD' },
      { '@type': 'Offer', name: 'The clean bundle', price: dollars(PRODUCTS.bundle.cents), priceCurrency: 'USD' },
    ],
  };
}

// The visit beacon: RepoHQ counts real use of the live site with three signals, POSTed as JSON
// { slug: 'alterpaw', kind, referrer } (see /privacy):
//   visit     once per browser session (sessionStorage), on every page that loads this script
//   activate  once per browser (localStorage), the first time a preview is made (upload.js dispatches
//             "alterpaw:activate" when POST /generate succeeds)
//   checkout  each time a pay form (data-checkout: Unlock, Buy it as a gift, Order the poster) is submitted
export const SIGNAL_ENDPOINT = 'https://repohq.vercel.app/api/ideas/signal';
export const SIGNAL_ORIGIN = new URL(SIGNAL_ENDPOINT).origin;
export const SIGNAL_SLUG = 'alterpaw';

// Runs in the browser, served as `(${fn})(endpoint, slug)`; it must not reference anything outside itself.
// Silent for automated browsers (navigator.webdriver), in the owner's browser (localStorage "repohq:notrack"
// set) and wherever storage can't be read, so nothing is ever counted twice or against an opt-out.
// Fire-and-forget: keepalive survives the navigation that follows a pay form or a new preview; no cookies, no
// Referer header, and the referrer field is set only when the visitor came from another site.
function beaconScript(endpoint, slug) {
  'use strict';
  function storage(name) {
    try {
      return window[name] || null;
    } catch (e) {
      return null;
    }
  }

  function silent() {
    if (navigator.webdriver) return true;
    var local = storage('localStorage');
    try {
      return !local || local.getItem('repohq:notrack') !== null;
    } catch (e) {
      return true;
    }
  }

  function referrer() {
    if (!document.referrer) return null;
    try {
      return new URL(document.referrer).origin !== location.origin ? document.referrer : null;
    } catch (e) {
      return null;
    }
  }

  function send(kind) {
    if (silent()) return;
    try {
      fetch(endpoint, {
        method: 'POST',
        keepalive: true,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: slug, kind: kind, referrer: referrer() }),
      }).catch(function () {});
    } catch (e) {
      // Never let counting break the page.
    }
  }

  // Sends `kind` unless this storage area already has it; no readable storage, no signal.
  function once(areaName, kind) {
    if (silent()) return;
    var area = storage(areaName);
    var key = 'repohq:' + slug + ':' + kind;
    try {
      if (!area || area.getItem(key) !== null) return;
      area.setItem(key, '1');
    } catch (e) {
      return;
    }
    send(kind);
  }

  once('sessionStorage', 'visit');
  document.addEventListener('alterpaw:activate', function () {
    once('localStorage', 'activate');
  });
  document.addEventListener(
    'submit',
    function (event) {
      var form = event.target;
      if (form && typeof form.hasAttribute === 'function' && form.hasAttribute('data-checkout')) send('checkout');
    },
    true,
  );
}

export const BEACON_SCRIPT = `(${beaconScript.toString()})(${JSON.stringify(SIGNAL_ENDPOINT)}, ${JSON.stringify(SIGNAL_SLUG)});\n`;
