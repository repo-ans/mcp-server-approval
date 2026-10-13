// Netlify entry point: the whole Express app as one function (see netlify.toml redirects).
import serverless from 'serverless-http';
import { createApp } from '../../src/app.js';

const app = createApp({
  // A serverless function is frozen once it responds, so Slack clicks are handed to a background
  // function (up to 15 min). It re-verifies the Slack signature itself, so it can't be called directly.
  dispatchSlackInteraction: async ({ rawBody, timestamp, signature, host }) => {
    const res = await fetch(`https://${host}/.netlify/functions/slack-worker-background`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': signature,
      },
      body: rawBody,
      signal: AbortSignal.timeout(2500),
    });
    if (res.status !== 202) throw new Error(`Background function returned ${res.status}`);
  },
});

export const handler = serverless(app);
