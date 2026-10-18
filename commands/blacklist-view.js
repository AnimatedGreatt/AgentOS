const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ComponentType } = require("discord.js");
const blacklistStore = require("../utils/blacklist/blacklistStore");
const config = require("../config");

const PAGE_SIZE = 10;

module.exports = {
  data: new SlashCommandBuilder()
    .setName("blacklist-view")
    .setDescription("View the blacklist roster"),

  async execute(interaction) {
    const ALLOWED_GUILD = config.BLACKLIST_GUILD_ID;
    if (!ALLOWED_GUILD) {
      await interaction.reply({ content: "⚠️ This command is not configured (BLACKLIST_GUILD_ID).", ephemeral: true });
      return;
    }

    if (interaction.guildId !== ALLOWED_GUILD) {
      await interaction.reply({ content: "❌ This command can only be used in the OSI server for security purposes.", ephemeral: true });
      return;
    }

    await interaction.deferReply();

    const archivalNotice = "⚠️ Notice: This command is disused and retained for archival purposes.";

    try {
      const rawList = await blacklistStore.listEntries();
      const list = Array.isArray(rawList) ? rawList : [];
      console.info(`[blacklist-view] listEntries returned ${list.length} rows (DATABASE_URL=${Boolean(config.DATABASE_URL)})`);
      if (!list.length) {
        if (config.DATABASE_URL) {
          await interaction.editReply(`${archivalNotice}\n\nThe blacklist roster is empty in the database. Confirm the Railway Postgres \`blacklist\` table has rows.`);
        } else {
          await interaction.editReply(`${archivalNotice}\n\nThe blacklist roster is currently empty.`);
        }
        return;
      }

      const totalPages = Math.ceil(list.length / PAGE_SIZE);
      let page = 0;

      function makeEmbedForPage(p) {
        const start = p * PAGE_SIZE;
        const slice = list.slice(start, start + PAGE_SIZE);
        const embed = new EmbedBuilder()
          .setTitle("Blacklist Roster")
          .setDescription(archivalNotice + "\n\n" + slice.map((entry, i) => {
            const addedBy = entry.added_by_name || 'N/A';
            return `${start + i + 1}. ${entry.username} — Added by: ${addedBy}`;
          }).join("\n"))
          .setFooter({ text: `Page ${p + 1} of ${totalPages} • ${list.length} entries` });
        return embed;
      }

      const token = `bl_${Date.now().toString(36)}`;
      function makeComponents(p) {
        const prev = new ButtonBuilder()
          .setCustomId(`${token}:prev`)
          .setLabel("◀️ Prev")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(p <= 0);
        const next = new ButtonBuilder()
          .setCustomId(`${token}:next`)
          .setLabel("Next ▶️")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(p >= totalPages - 1);
        const row = new ActionRowBuilder().addComponents(prev, next);
        return { components: [row] };
      }

      const embed = makeEmbedForPage(page);
      const comps = makeComponents(page);

      await interaction.editReply({ embeds: [embed], components: comps.components });
      const message = await interaction.fetchReply();

      const filter = (i) => i.isButton() && typeof i.customId === "string" && i.customId.startsWith(token + ":");
      const collector = message.createMessageComponentCollector({ filter, componentType: ComponentType.Button, time: 10 * 60 * 1000 });

      collector.on("collect", async (btnInt) => {
        try {
          await btnInt.deferUpdate();
          const [, action] = btnInt.customId.split(":");
          if (action === "prev" && page > 0) page -= 1;
          if (action === "next" && page < totalPages - 1) page += 1;
          const newEmbed = makeEmbedForPage(page);
          const newComps = makeComponents(page);
          // reuse same token so collector continues to match
          await message.edit({ embeds: [newEmbed], components: newComps.components });
        } catch (e) {
          console.error("blacklist-list collector error:", e);
        }
      });

      collector.on("end", async () => {
        try {
          // disable buttons when finished
          const disabledRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("disabled_prev").setLabel("◀️ Prev").setStyle(ButtonStyle.Primary).setDisabled(true),
            new ButtonBuilder().setCustomId("disabled_next").setLabel("Next ▶️").setStyle(ButtonStyle.Primary).setDisabled(true)
          );
          await message.edit({ components: [disabledRow] });
        } catch (e) {
          // ignore
        }
      });

    } catch (err) {
      console.error("blacklist-list error:", err);
      await interaction.editReply({ content: "Could not load the blacklist roster." });
    }
  }
};
