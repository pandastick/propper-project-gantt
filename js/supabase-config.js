/**
 * supabase-config.js — PPGantt Supabase client config
 *
 * Single source of truth for the Supabase URL + publishable (anon) key.
 * Both login.html and js/supabase-gate.js import these. If you rotate
 * the Supabase project or publishable key, update here and redeploy —
 * no other files need to change.
 *
 * The publishable (anon) key is safe to ship in the browser: it only
 * grants the permissions Supabase RLS has been configured to allow for
 * the `anon` and `authenticated` roles. Row-level security policies
 * (set up in migrations 0001-0004) are what actually gate the data.
 */

export const SUPABASE_URL = 'https://wzzjozdljxhmrmscevlh.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_PaqDBOkhEy2GCFLoVQ2MUw_0-Oznjju';
