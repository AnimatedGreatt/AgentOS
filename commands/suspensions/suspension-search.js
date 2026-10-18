const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require("discord.js");
const axios = require("axios");

const BOARD_ID = process.env.TRELLO_SUSPENSIONS_BOARD_ID || "693f1533319531ec08ae2ff4";
const TRELLO_KEY = process.env.TRELLO_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;

module.exports = {
	data: new SlashCommandBuilder()
		.setName("suspension-search")
		.setDescription("Search the suspensions Trello board for a username or term")
		.addStringOption(option =>
			option
				.setName("query")
				.setDescription("Username or term to search for")
				.setRequired(true)
		),

	async execute(interaction) {
		const query = (interaction.options.getString("query") || "").trim();
		if (!query) {
			const e = new EmbedBuilder().setTitle('Suspension Search').setColor(0xed4245).setDescription('Provide a search query.');
			await interaction.reply({ embeds: [e], ephemeral: false });
			return;
		}
		if (!TRELLO_KEY || !TRELLO_TOKEN) {
			const e = new EmbedBuilder().setTitle('Suspension Search').setColor(0xed4245).setDescription('Trello credentials are not configured.');
			await interaction.reply({ embeds: [e], ephemeral: false });
			return;
		}

		await interaction.deferReply();

		try {
			const res = await axios.get(`https://api.trello.com/1/boards/${BOARD_ID}/cards`, {
				params: {
					key: TRELLO_KEY,
					token: TRELLO_TOKEN,
					fields: "name,desc,url,due,labels,idList",
				}
			});
			const cards = Array.isArray(res.data) ? res.data : [];
			// fetch lists to map id -> name so we can special-case a list name
			const listsRes = await axios.get(`https://api.trello.com/1/boards/${BOARD_ID}/lists`, {
				params: { key: TRELLO_KEY, token: TRELLO_TOKEN, fields: "name" }
			});
			const lists = Array.isArray(listsRes.data) ? listsRes.data : [];
			const listNameById = {};
			for (const l of lists) {
				if (l && l.id) listNameById[l.id] = String(l.name || "");
			}
			const q = query.toLowerCase();
			const matches = cards.filter(c => {
				const hay = `${String(c.name || "")}\n${String(c.desc || "")}`.toLowerCase();
				return hay.includes(q);
			});

			if (!matches.length) {
				const no = new EmbedBuilder().setTitle('No Results').setColor(0xedd400).setDescription(`No results found for "${query}".`);
				await interaction.editReply({ embeds: [no] });
				return;
			}

			const MAX = 10; // results per embed
			const totalPages = Math.ceil(matches.length / MAX);
			const embeds = [];
			for (let p = 0; p < totalPages; p++) {
				const pageEmbed = new EmbedBuilder()
					.setTitle(`Results for "${query}"${totalPages > 1 ? ` — Page ${p + 1}/${totalPages}` : ""}`)
					.setColor(0x00aff1)
					.setTimestamp(new Date());
				const slice = matches.slice(p * MAX, (p + 1) * MAX);
				for (const c of slice) {
					const listName = c.idList ? (listNameById[c.idList] || "") : "";
					// Prefer an explicit requested length if present in the card description.
					// The duration is always whatever follows "Requested Time:" on the same line.
					let durationText = null;
					if (c.desc) {
						const m = String(c.desc).match(/Requested Time:\s*([^\r\n]+)/i);
						if (m && m[1]) durationText = m[1].replace(/\*/g, '').trim();
					}
					let displayText;
					if (durationText) {
						displayText = durationText;
					} else if (c.due) {
						displayText = new Date(c.due).toISOString().split("T")[0];
					} else if (listName === "Arrests") {
						displayText = "Arrest Log";
					} else {
						displayText = "Permanent";
					}
					const labels = Array.isArray(c.labels) ? c.labels.map(l => l.name).filter(Boolean).join(", ") : "";
					const value = `${displayText}${labels ? ` — ${labels}` : ""}\n${c.url}`;
					pageEmbed.addFields({ name: String(c.name).slice(0, 256) || '(untitled)', value: value.slice(0, 1024) });
				}
				embeds.push(pageEmbed);
			}
			// Send first page and attach navigation buttons if more pages exist.
			let pageIndex = 0;
			const makeRow = (idx) => new ActionRowBuilder().addComponents(
				new ButtonBuilder().setCustomId(`susp_search_prev_${interaction.id}`).setLabel('Prev').setStyle(ButtonStyle.Primary).setDisabled(idx <= 0),
				new ButtonBuilder().setCustomId(`susp_search_next_${interaction.id}`).setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(idx >= embeds.length - 1),
			);

			await interaction.editReply({ embeds: [embeds[0]], components: embeds.length > 1 ? [makeRow(0)] : [] });
			if (embeds.length <= 1) return;

			const msg = await interaction.fetchReply();
			const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120000 });

			collector.on('collect', async i => {
				if (i.user.id !== interaction.user.id) {
					await i.reply({ content: 'These buttons aren\'t for you.', ephemeral: true });
					return;
				}
				if (i.customId === `susp_search_prev_${interaction.id}`) {
					pageIndex = Math.max(0, pageIndex - 1);
				} else if (i.customId === `susp_search_next_${interaction.id}`) {
					pageIndex = Math.min(embeds.length - 1, pageIndex + 1);
				}
				await i.update({ embeds: [embeds[pageIndex]], components: [makeRow(pageIndex)] });
			});

			collector.on('end', async () => {
				try {
					const disabled = new ActionRowBuilder().addComponents(
						new ButtonBuilder().setCustomId(`susp_search_prev_${interaction.id}`).setLabel('Prev').setStyle(ButtonStyle.Primary).setDisabled(true),
						new ButtonBuilder().setCustomId(`susp_search_next_${interaction.id}`).setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(true),
					);
					await interaction.editReply({ components: [disabled] });
				} catch (e) {
					// ignore
				}
			});
		} catch (err) {
			console.error("suspension-search error:", err);
			const e = new EmbedBuilder().setTitle('Search Error').setColor(0xed4245).setDescription('Could not search the suspensions board.');
			await interaction.editReply({ embeds: [e] });
		}
	}
};
