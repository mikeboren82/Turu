const { createClient } = require('@supabase/supabase-js');

let sessionPromise = null;

// opts.fetch (optional, first call only): custom fetch for every request of this process's client
function getClient(opts = {}) {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY, opts.fetch ? { global: { fetch: opts.fetch } } : undefined);
      const { data, error } = await client.auth.signInWithPassword({
        email: process.env.SUPABASE_BOT_EMAIL,
        password: process.env.SUPABASE_BOT_PASSWORD,
      });
      if (error) throw new Error('כשלון התחברות לחשבון המערכת של Supabase: ' + error.message);
      return { client, userId: data.user.id };
    })();
    sessionPromise.catch(() => { sessionPromise = null; });
  }
  return sessionPromise;
}

module.exports = { getClient };
