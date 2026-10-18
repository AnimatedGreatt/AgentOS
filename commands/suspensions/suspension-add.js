const { SlashCommandBuilder } = require("discord.js");
const axios = require("axios");

const BOARD_ID = process.env.TRELLO_SUSPENSIONS_BOARD_ID || "693f1533319531ec08ae2ff4";
const TRELLO_KEY = process.env.TRELLO_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;

const ALLOWED_ROLE_IDS = [
  "1449860639475630240", // MC [OSI]
  "1449860815086813224", // HC [OSI]
  "994282089727918171", // Colonel
  "1244119045377228800", // E-9C
  "994282088494792804", // O-7
  "994282087488167936", // O-8
  "1272299641756450947", // O-9
  "1272299640129323088", // O-10
  "1044337168308519074", // NID [CLASSIFIED]
  "1106739929540730921", // Oversight [OSI]
  "1449861438012133566" // case eval role
];

const ALLOWED_USER_IDS = [
  "716248402513494027"
];

const LIST_NAMES = ["Approved", "Permanent"];
const LABEL_NAMES = ["OSI Approved", "DoW Approved"];
const TIME_PATTERN = /^(\d+)\s*(day|days|week|weeks|month|months)$/i;

async function getListIdByName(listName) {
  const res = await axios.get(`https://api.trello.com/1/boards/${BOARD_ID}/lists`, {
    params: { key: TRELLO_KEY, token: TRELLO_TOKEN, fields: "name" }
  });
  const lists = Array.isArray(res.data) ? res.data : [];
  const match = lists.find(l => String(l.name || "").toLowerCase() === listName.toLowerCase());
  return match ? match.id : null;
}

async function getLabelIdByName(labelName) {
  const res = await axios.get(`https://api.trello.com/1/boards/${BOARD_ID}/labels`, {
    params: { key: TRELLO_KEY, token: TRELLO_TOKEN, fields: "name,color", limit: 1000 }
  });
  const labels = Array.isArray(res.data) ? res.data : [];
  const match = labels.find(l => String(l.name || "").toLowerCase() === labelName.toLowerCase());
  return match ? match.id : null;
}

function parseRequestedTime(input) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw || raw === "permanent") return null;
  const match = raw.match(TIME_PATTERN);
  if (!match) return null;

  const value = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(value) || value <= 0) return null;

  const date = new Date();
  if (unit.startsWith("day")) {
    date.setDate(date.getDate() + value);
  } else if (unit.startsWith("week")) {
    date.setDate(date.getDate() + value * 7);
  } else if (unit.startsWith("month")) {
    date.setMonth(date.getMonth() + value);
  }
  return date.toISOString();
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("suspension-add")
    .setDescription("Add a suspension card to Trello")
    .addStringOption(option =>
      option
        .setName("title")
        .setDescription("Card title - This should be the suspect's name")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("list")
        .setDescription("Which list to add to")
        .setRequired(true)
        .addChoices(
          { name: "Approved", value: "Approved" },
          { name: "Permanent", value: "Permanent" }
        )
    )
    .addStringOption(option =>
      option
        .setName("label")
        .setDescription("Label to apply - Only select DoW Approved if O-7+ approved.")
        .setRequired(true)
        .addChoices(
          { name: "OSI Approved", value: "OSI Approved" },
          { name: "DoW Approved", value: "DoW Approved" }
        )
    )
    .addStringOption(option =>
      option
        .setName("user_profile")
        .setDescription("User Profile (link)")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("divisional_ranks")
        .setDescription("Divisional Ranks - Follow format of (Abbreviation) Rank Name, separate multiple ranks with commas")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("requested_time")
        .setDescription("Requested Time - Must follow format of X days/weeks/months or 'Permanent'")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("broken_laws")
        .setDescription("Broken Laws - Separate multiple laws with commas, follow format of [X.X] Law Name")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("proof")
        .setDescription("Proof of Offense (link to case file/proof)")
        .setRequired(true)
    ),

  async execute(interaction) {
    if (!ALLOWED_USER_IDS.includes(interaction.user.id)) {
      const hasRole = interaction.member?.roles?.cache?.some(role => ALLOWED_ROLE_IDS.includes(role.id));
      if (!hasRole) {
        await interaction.reply({ content: "❌ You do not have permission to use this command.", ephemeral: true });
        return;
      }
    }

    if (!TRELLO_KEY || !TRELLO_TOKEN) {
      await interaction.reply({ content: "⚠️ Trello API credentials are not configured.", ephemeral: true });
      return;
    }

    const title = interaction.options.getString("title");
    const listName = interaction.options.getString("list");
    const labelName = interaction.options.getString("label");
    const userProfile = interaction.options.getString("user_profile");
    const divisionalRanks = interaction.options.getString("divisional_ranks");
    const requestedTime = interaction.options.getString("requested_time");
    const brokenLaws = interaction.options.getString("broken_laws");
    const proof = interaction.options.getString("proof");

    await interaction.deferReply({ ephemeral: true });

    try {
      if (!LIST_NAMES.includes(listName)) {
        await interaction.editReply("⚠️ Invalid list selection.");
        return;
      }

      if (!LABEL_NAMES.includes(labelName)) {
        await interaction.editReply("⚠️ Invalid label selection.");
        return;
      }

      const listId = await getListIdByName(listName);
      if (!listId) {
        await interaction.editReply("⚠️ Could not find the Trello list.");
        return;
      }

      const labelId = await getLabelIdByName(labelName);
      if (!labelId) {
        await interaction.editReply("⚠️ Could not find the Trello label.");
        return;
      }

      const desc = [
        `User Profile: ${userProfile}`,
        `Divisional Ranks: ${divisionalRanks}`,
        `Requested Time: ${requestedTime}`,
        `Broken Laws: ${brokenLaws}`,
        `Proof of Offense: ${proof}`
      ].join("\n");

      const dueDate = parseRequestedTime(requestedTime);

      await axios.post("https://api.trello.com/1/cards", null, {
        params: {
          idList: listId,
          name: title,
          desc,
          idLabels: labelId,
          due: dueDate || undefined,
          key: TRELLO_KEY,
          token: TRELLO_TOKEN
        }
      });

      await interaction.editReply("✅ Suspension card created.");
    } catch (err) {
      console.error("Failed to create suspension card:", err);
      await interaction.editReply("⚠️ Could not create the suspension card.");
    }
  }
};
