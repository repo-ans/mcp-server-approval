// Netlify background function (the "-background" suffix makes Netlify reply 202 immediately and run this
// for up to 15 minutes). Executes Slack Approve/Reject clicks forwarded by the api function.
import '../../src/registry.js'; // registers write tools + workflows so approvals can execute here
import { handleSlackInteraction } from '../../src/core/approval.js';
import { parseSlackInteraction } from '../../src/core/slack.js';

export default async (req: Request): Promise<void> => {
  const payload = parseSlackInteraction(
    await req.text(),
    req.headers.get('x-slack-request-timestamp') ?? undefined,
    req.headers.get('x-slack-signature') ?? undefined,
  );
  if (!payload) {
    console.error('slack-worker-background: invalid Slack signature, ignoring');
    return;
  }
  await handleSlackInteraction(payload);
};
