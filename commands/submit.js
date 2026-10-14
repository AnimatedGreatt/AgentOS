const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const config = require('../config');

module.exports = {
    data: new SlashCommandBuilder()
        .setName("submit")
        .setDescription("Submit a case for review")
        .addStringOption(option =>
            option
                .setName("link")
                .setDescription("Link to the case file")
                .setRequired(true),
        )
        .addStringOption(option =>
            option
                .setName("casenumber")
                .setDescription("The identifying number of the case")
                .setRequired(true),
        )
        .addStringOption(option =>
            option
                .setName("verdict")
                .setDescription("The verdict of the case")
                .setRequired(true)
                .addChoices(
                    { name: "Guilty", value: "Guilty" },
                    { name: "Innocent", value: "Innocent" },
                    { name: "Dismissed", value: "Dismissed" }
                ),
        )
        .addStringOption(option =>
            option
                .setName("suspect")
                .setDescription("Username of the suspect")
                .setRequired(true),
        ),

        guildOnly: config.GUILD_ID || undefined,

    // gets the inputs in the command
    async execute(interaction) {
        const link = interaction.options.getString("link");
        const casenumber = interaction.options.getString("casenumber");
        const verdict = interaction.options.getString("verdict");
        const suspect = interaction.options.getString("suspect");
        await interaction.deferReply({ ephemeral: true });

        try {

        // builds the embed
        const embed = new EmbedBuilder()
            .setTitle(`Case Submission - #${casenumber}`)
            .setDescription(`Submitted by ${interaction.user}`)
            .addFields(
                { name: "Case File", value: `[View Case File](${link})`, inline: false },
                { name: "Case Number", value: `${casenumber}`, inline: false },
                { name: "Suspect Username", value: `${suspect}`, inline: false },
                { name: "Verdict", value: `${verdict}`, inline: false }
            )
            .setColor(0x00aff1)
            .setTimestamp();
        
        let components = []; // default: no button

        const config = require('../config');
        const targetChannelId = (verdict === 'Guilty') ? config.SUBMIT_GUILTY_CHANNEL_ID : config.SUBMIT_INNOCENT_CHANNEL_ID;

        if (verdict === "Guilty") {
            const approveButton = new ButtonBuilder()
            .setCustomId("approve_request")
            .setLabel("Approve")
            .setStyle(ButtonStyle.Success);

            components.push(new ActionRowBuilder().addComponents(approveButton));
        }

        try {
            const targetChannel = await interaction.client.channels.fetch(targetChannelId).catch(() => null);
            if (!targetChannel) {
                await interaction.editReply({ content: `Failed to find target channel <#${targetChannelId}>.`, ephemeral: true });
                return;
            }
            const sent = await targetChannel.send({ embeds: [embed], components });
            const link = sent && sent.url ? sent.url : `https://discord.com/channels/${interaction.guildId}/${targetChannelId}/${sent.id}`;
            await interaction.editReply({ content: `Submitted to <#${targetChannelId}>: ${link}`, ephemeral: true });
        } catch (err) {
            console.error('submit send error:', err);
            await interaction.editReply({ content: '⚠️ Something went wrong sending the submission.', ephemeral: true });
        }

        
        } catch (err) {
                console.error(err);
                await interaction.editReply("⚠️ Something went wrong.");
        }
    }
};