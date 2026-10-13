import 'dotenv/config';
import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v === 'true' || v === '1'));

const EnvSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    HCP_MOCK: bool(false),
    HCP_MOCK_WRITES: bool(true),
    HCP_API_KEY: z.string().optional(),
    HCP_BASE_URL: z.string().url().default('https://api.housecallpro.com'),
    SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
    SLACK_BOT_TOKEN: z.string().startsWith('xoxb-', 'must be a bot token starting with xoxb-'),
    SLACK_SIGNING_SECRET: z.string().min(10),
    SLACK_CHANNEL_ID: z.string().regex(/^[CG][A-Z0-9]+$/, 'must be a channel id like C0123ABCD (not the #name)'),
    SLACK_APPROVER_IDS: z.string().optional(),
    SLACK_ADMIN_IDS: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().optional().transform((v) => v || 'claude-opus-5-5'),
  })
  .refine((env) => env.HCP_MOCK || !!env.HCP_API_KEY, {
    message: 'HCP_API_KEY is required unless HCP_MOCK=true',
    path: ['HCP_API_KEY'],
  });

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  port: env.PORT,
  hcp: {
    mock: env.HCP_MOCK,
    mockWrites: env.HCP_MOCK_WRITES,
    apiKey: env.HCP_API_KEY ?? '',
    baseUrl: env.HCP_BASE_URL.replace(/\/$/, ''),
  },
  supabase: {
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  },
  slack: {
    botToken: env.SLACK_BOT_TOKEN,
    signingSecret: env.SLACK_SIGNING_SECRET,
    channelId: env.SLACK_CHANNEL_ID,
    // Optional allow-list of Slack user ids who may approve. Empty = anyone in the channel.
    approverIds: (env.SLACK_APPROVER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    // Slack user ids allowed to manage API keys with /hcp-agent. Empty = command disabled.
    adminIds: (env.SLACK_ADMIN_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  },
  anthropic: {
    // Only needed for the job request workflow (email/PDF -> Claude extraction).
    apiKey: env.ANTHROPIC_API_KEY ?? '',
    model: env.ANTHROPIC_MODEL,
  },
};
