import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

// Server-side only: the service role key bypasses RLS. Never expose it to clients.
export const db = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
