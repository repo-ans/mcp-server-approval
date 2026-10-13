// Long-running server entry point: `npm run dev`, `npm start`, pm2 or Docker on a VPS.
import { config } from './config.js';
import { createApp } from './app.js';
import { handleSlackInteraction } from './core/approval.js';

const app = createApp({
  // The process stays alive, so handle the click in-process after Slack gets its 200.
  dispatchSlackInteraction: async ({ payload }) => {
    void handleSlackInteraction(payload).catch((err) => console.error('Slack action failed:', err));
  },
});

app.listen(config.port, () => {
  console.log(`MCP server listening on http://localhost:${config.port}/mcp  (HCP_MOCK=${config.hcp.mock}, HCP_MOCK_WRITES=${config.hcp.mockWrites})`);
});
