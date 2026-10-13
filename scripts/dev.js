// Local server: `npm run dev`, then open http://localhost:3000
// With no DATABASE_URL, previews live in memory until the process stops.
// With no model key (LLM_API_KEY or GOOGLE_API_KEY), a canned demo character is used, so the whole flow
// can be clicked through offline. Set the variables in your shell to use the real services.
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from '../src/app.js';
import { depsFromEnv } from '../src/index.js';
import { MemoryStore } from '../src/store.js';
import { findAlterEgo } from '../src/character.js';

export function demoComplete(messages) {
  const pet = JSON.parse(messages[1].content.slice(messages[1].content.indexOf('{')));
  const ego = findAlterEgo(pet.alterEgo)?.label ?? pet.alterEgo;
  const [first = 'mysterious', second = 'restless', third = 'hungry'] = pet.traits;
  return JSON.stringify({
    alias: `${pet.name} "The ${first}" ${ego}`,
    rapSheet: [
      `Being ${first} in a public place`,
      `Aggravated ${second}ness, second offence`,
      `Conspiracy to commit ${third} acts before breakfast`,
    ],
    stats: [
      { label: 'Menace', value: 87 },
      { label: 'Charm', value: 99 },
      { label: 'Snack Theft', value: 93 },
      { label: 'Nap Power', value: 76 },
      { label: 'Alibi', value: 12 },
    ],
    headline: `${pet.name.toUpperCase()} SPOTTED LIVING SECRET LIFE AS ${ego.toUpperCase()}`,
    article: `Neighbours were stunned this week when ${pet.name}, a local ${pet.species} known for being ${first}, was revealed to be ${ego.toLowerCase()}. "We always wondered," said one witness. (Demo text: set GOOGLE_API_KEY for the real writer.)`,
    bio: `${pet.name} rose from humble beginnings to become the most ${second} ${ego.toLowerCase()} on the block. (Demo text.)`,
  });
}

function main(env) {
  const deps = depsFromEnv(env);
  if (!env.DATABASE_URL) {
    deps.store = new MemoryStore();
    console.log('No DATABASE_URL: previews are kept in memory.');
  }
  if (!env.LLM_API_KEY && !env.GOOGLE_API_KEY) {
    deps.complete = async (messages) => demoComplete(messages);
    console.log('No model key: using canned demo text.');
  }
  if (!env.CRON_SECRET) console.log('No CRON_SECRET: GET /jobs/expire-photos answers 503 (set it to try the job).');
  const port = Number(env.PORT) || 3000;
  serve({ fetch: createApp(deps).fetch, port }, (info) => {
    console.log(`alterpaw running at http://localhost:${info.port}`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.env);
