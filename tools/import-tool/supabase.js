const { createClient } = require('@supabase/supabase-js');

let sessionPromise = null;

function getClient() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);
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
