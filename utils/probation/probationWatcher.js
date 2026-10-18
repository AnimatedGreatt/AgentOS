const config = require('../../config');
const { EmbedBuilder } = require('discord.js');
const probationStore = require('./probationStore');
const verificationStore = require('../verification/verificationStore');

function resolveRoleToken(token, guild) {
  if (!token || !guild) return null;
  const t = String(token).trim();
  const idMatch = t.match(/(\d{5,})/);
  if (idMatch) {
    const id = idMatch[1];
    const byId = guild.roles.cache.get(id);
    if (byId) return byId;
  }
  if (guild.roles.cache.get(t)) return guild.roles.cache.get(t);
  return guild.roles.cache.find(r => r.name.toLowerCase() === t.toLowerCase()) || null;
}

async function evaluateMember(member, context = {}) {
  try {
    const guild = member.guild;
    // Ensure latest member data
    try { member = await guild.members.fetch(member.id, { force: true }).catch(() => member); } catch (e) {}

    const suspiciousTokens = String(config.PROBATION_SUSPICIOUS_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    const requiredTokens = String(config.PROBATION_REQUIRED_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

    const matchedSuspicious = suspiciousTokens.map(tok => {
      const role = resolveRoleToken(tok, guild);
      const id = role ? role.id : String(tok).trim();
      const name = role ? role.name : String(tok).trim();
      const has = !!member.roles.cache.has(id);
      return { id, name, has };
    }).filter(x => x.has);

    if (matchedSuspicious.length > 0) {
      const alertChanId = config.PROBATION_ALERT_CHANNEL_ID || config.LOG_CHANNEL_ID;
      const chan = await member.client.channels.fetch(alertChanId).catch(() => null);
      const names = matchedSuspicious.map(x => x.name).join(', ');
      if (chan) {
        const embed = new EmbedBuilder()
          .setTitle('Probation Alert')
          .setColor(config.EMBED_COLOR || 0xffa500)
          .setDescription(`Probationary agent with prohibited roles has joined OSI. Has the following roles: ${names}`)
          .addFields(
            { name: 'Member', value: `${member.user.tag} (<@${member.user.id}>)`, inline: true },
            { name: 'Context', value: context.reason || 'role update', inline: true }
          )
          .setTimestamp();
        await chan.send({ embeds: [embed] }).catch(() => null);
      }
      return;
    }

    const requiredInfo = requiredTokens.map(tok => {
      const role = resolveRoleToken(tok, guild);
      const id = role ? role.id : String(tok).trim();
      const name = role ? role.name : String(tok).trim();
      const has = !!member.roles.cache.has(id);
      return { id, name, has };
    });
    const hasAnyRequired = requiredInfo.some(r => r.has);
    if (!hasAnyRequired) {
      const alertChanId = config.PROBATION_ALERT_CHANNEL_ID || config.LOG_CHANNEL_ID;
      const chan = await member.client.channels.fetch(alertChanId).catch(() => null);
      const requiredNames = requiredInfo.map(x => x.name).join(', ');
      if (chan) {
        const embed = new EmbedBuilder()
          .setTitle('Probation Alert')
          .setColor(config.EMBED_COLOR || 0xffa500)
          .setDescription(`Probationary agent missing required roles has joined OSI. Required roles: ${requiredNames}`)
          .addFields(
            { name: 'Member', value: `${member.user.tag} (<@${member.user.id}>)`, inline: true },
            { name: 'Context', value: context.reason || 'role update', inline: true }
          )
          .setTimestamp();
        await chan.send({ embeds: [embed] }).catch(() => null);
      }
    }
  } catch (e) {
    console.error('probationWatcher evaluateMember failed:', e);
  }
}

function init(client) {
  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    try {
      // Only handle role changes
      const oldRoles = new Set(oldMember.roles.cache.keys());
      const newRoles = new Set(newMember.roles.cache.keys());
      let changed = false;
      for (const r of newRoles) if (!oldRoles.has(r)) changed = true;
      for (const r of oldRoles) if (!newRoles.has(r)) changed = true;
      if (!changed) return;

      // Check if we have a pending probation webhook entry for this user
      const pending = probationStore.getByDiscord(newMember.id) || probationStore.getByRoblox(newMember.user.username);
      if (!pending) return; // only act when webhook recently reported probationary join

      // Evaluate the member now (authoritative)
      await evaluateMember(newMember, { reason: 'post-webhook role change' });
      // Remove pending so we don't duplicate
      try { probationStore.removeByDiscord(newMember.id); probationStore.removeByRoblox(pending.robloxUsername); } catch (e) {}
    } catch (e) {
      console.error('Error in guildMemberUpdate probation watcher:', e);
    }
  });
}

module.exports = { init, evaluateMember };
