const { getExpired, removeEntry } = require('./inactivityStore');

function startInactivityScheduler(client, intervalMs = 5 * 60 * 1000) {
  if (!client) throw new Error('Client required');

  async function tick() {
    try {
      const expired = await getExpired(new Date());
      for (const row of expired) {
        try {
          if (row.discord_id) {
            const user = await client.users.fetch(row.discord_id).catch(() => null);
            if (user) {
              await user.send(`Your inactivity notice has expired for ${row.roblox_username}. You have been returned to active status.`).catch(() => null);
            }
          }
        } catch (err) {
          console.error('Failed to DM expired user:', err);
        }
        try {
          await removeEntry(row.roblox_username);
        } catch (err) {
          console.error('Failed to remove expired inactivity entry:', err);
        }
      }
    } catch (err) {
      console.error('Inactivity scheduler tick failed:', err);
    }
  }

  // Run immediately, then on interval
  tick().catch(err => console.error(err));
  const id = setInterval(tick, intervalMs);
  return () => clearInterval(id);
}

module.exports = { startInactivityScheduler };
