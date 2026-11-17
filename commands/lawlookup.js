const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const axios = require("axios");

const BOARD_ID = process.env.TRELLO_BOARD_ID || "672b06f4764eb48b5e3c92b3";
const TRELLO_KEY = process.env.TRELLO_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;

function normalize(text) {
  return String(text || "").toLowerCase();
}

function truncate(text, maxLen) {
  const value = String(text || "");
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen - 3) + "...";
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("lawlookup")
    .setDescription("Lookup a law from the UCMJ Trello by card name")
    .addStringOption(option =>
      option
        .setName("query")
        .setDescription("Search text for the law")
        .setRequired(true)
    ),

  async execute(interaction) {
    const query = interaction.options.getString("query");
    await interaction.deferReply();

    if (!TRELLO_KEY || !TRELLO_TOKEN) {
      await interaction.editReply("Trello API credentials are not configured.");
      return;
    }

    try {
      const url = `https://api.trello.com/1/boards/${BOARD_ID}/cards`;
      const response = await axios.get(url, {
        params: {
          key: TRELLO_KEY,
          token: TRELLO_TOKEN,
          fields: "name,desc,shortUrl,labels,closed"
        }
      });

      const cards = Array.isArray(response.data) ? response.data : [];
      const q = normalize(query);
      const openCards = cards.filter(card => !card.closed);

      const exact = openCards.filter(card => normalize(card.name) === q);
      const matches = exact.length > 0
        ? exact
        : openCards.filter(card => normalize(card.name).includes(q));

      if (matches.length === 0) {
        await interaction.editReply("No matching law found.");
        return;
      }

      const card = matches[0];
      const embed = new EmbedBuilder()
        .setTitle(card.name)
        .setColor(0x00aff1)
        .setDescription(truncate(card.desc || "No description provided.", 3800))
        .addFields({ name: "Trello", value: card.shortUrl || "(no link)", inline: false })
        .setFooter({ text: `Matches: ${matches.length}` });

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error("Law lookup failed:", err);
      await interaction.editReply("An error occurred while looking up the law. Contact the Department of Engineering.");
    }
  }
};
