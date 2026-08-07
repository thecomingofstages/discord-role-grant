require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');

const { createApp } = require('./authServer');
const { lookupByEmail, upsertBaseDataRow, invalidateConfigCache } = require('./sheets');
const { computeAssignment } = require('./assignmentLogic');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // required for nickname/role management
  ],
});

// ---- Slash command registration ----
const commands = [
  new SlashCommandBuilder()
    .setName('register')
    .setDescription('Sign in with Google to get your roles and nickname assigned automatically.'),
  new SlashCommandBuilder()
    .setName('refresh-roles')
    .setDescription('(Admin) Force-refresh the cached Discord role ID mapping from the CONFIG sheet.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
    { body: commands }
  );
  console.log('Slash commands registered.');
}

// ---- OAuth web server, wired to push results straight to Discord ----
const app = createApp({
  onGoogleEmailReceived: handleGoogleEmail,
});

app.listen(process.env.PORT, () => {
  console.log(`Auth server listening on port ${process.env.PORT}`);
});

// ---- Slash command handler ----
client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === 'register') {
    const authUrl = `${process.env.PUBLIC_BASE_URL}/auth?discord_id=${interaction.user.id}`;

    await interaction.reply({
      content:
        `Click the link below to sign in with Google. This lets us look up your registration details.\n\n` +
        `🔗 ${authUrl}\n\n` +
        `_(This opens in your browser. Once you've signed in, come back here — I'll DM you with what I found.)_`,
      ephemeral: true,
    });
    return;
  }

  if (interaction.isChatInputCommand() && interaction.commandName === 'refresh-roles') {
    invalidateConfigCache();
    await interaction.reply({
      content: '✅ Role ID cache cleared. The next lookup will pull fresh data from the CONFIG sheet.',
      ephemeral: true,
    });
    return;
  }

  if (interaction.isButton()) {
    await handleButtonInteraction(interaction);
  }
});

// ---- Called when the web server receives a Google sign-in result ----
async function handleGoogleEmail(discordId, email) {
  try {
    const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
    const member = await guild.members.fetch(discordId).catch(() => null);

    let user;
    try {
      user = await client.users.fetch(discordId);
    } catch (e) {
      console.error(`Could not fetch Discord user ${discordId}:`, e);
      return;
    }

    const lookup = await lookupByEmail(email);

    if (lookup.status === 'not_found') {
      await user.send(
        `I couldn't find **${email}** in our registration sheet. ` +
          `Please double check you signed in with the correct Google account, or contact an admin.`
      );
      return;
    }

    if (lookup.status === 'duplicate') {
      await user.send(
        `The email **${email}** appears more than once in our registration sheet, so I can't safely assign roles automatically. ` +
          `Please contact an admin to sort this out.`
      );
      return;
    }

    // status === 'found'
    const assignment = await computeAssignment(lookup);

    const embed = new EmbedBuilder()
      .setTitle('Registration found — confirm your details')
      .setColor(0x5865f2)
      .addFields(
        { name: 'Full name', value: assignment.fullname || '—', inline: true },
        { name: 'Nickname', value: assignment.nickname || '—', inline: true },
        { name: 'Email', value: assignment.email || '—', inline: false },
        {
          name: 'Roles to be assigned',
          value: assignment.roleNamesForDisplay.length
            ? assignment.roleNamesForDisplay.map((r) => `• ${r}`).join('\n')
            : '_None_',
        },
        { name: 'New server nickname will be', value: assignment.suggestedNickname || '—' }
      );

    if (assignment.unmappedRoles.length > 0) {
      embed.addFields({
        name: '⚠️ Note',
        value: `These roles don't have a Discord role configured yet, so they won't be assigned automatically: ${assignment.unmappedRoles.join(
          ', '
        )}. An admin needs to add their role IDs to the bot config.`,
      });
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`confirm_assign:${discordId}`)
        .setLabel('Confirm — assign roles & rename me')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`deny_assign:${discordId}`)
        .setLabel('Deny — I will be assigned manually')
        .setStyle(ButtonStyle.Danger)
    );

    // Stash the computed assignment so the button handler doesn't need to
    // re-derive it (and so the sheet snapshot used for confirmation matches
    // what actually gets applied).
    pendingAssignments.set(discordId, { assignment, member: member?.id });

    await user.send({ embeds: [embed], components: [row] });
  } catch (err) {
    console.error('handleGoogleEmail error:', err);
  }
}

const pendingAssignments = new Map(); // discordId -> { assignment }

async function handleButtonInteraction(interaction) {
  const [action, discordId] = interaction.customId.split(':');

  if (interaction.user.id !== discordId) {
    await interaction.reply({ content: 'This confirmation is not for you.', ephemeral: true });
    return;
  }

  const pending = pendingAssignments.get(discordId);
  if (!pending) {
    await interaction.update({
      content: 'This request has expired. Please run /register again.',
      embeds: [],
      components: [],
    });
    return;
  }

  if (action === 'deny_assign') {
    pendingAssignments.delete(discordId);
    await interaction.update({
      content: 'No problem — an admin will assign your roles and nickname manually.',
      embeds: [],
      components: [],
    });
    return;
  }

  if (action === 'confirm_assign') {
    const { assignment } = pending;
    await interaction.deferUpdate();
    try {
      const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
      const member = await guild.members.fetch(discordId);

      // Assign roles
      if (assignment.roleIdsToAssign.length > 0) {
        await member.roles.add(assignment.roleIdsToAssign);
      }

      // Rename
      if (assignment.suggestedNickname) {
        await member.setNickname(assignment.suggestedNickname).catch((e) => {
          console.error(`Could not set nickname for ${discordId} (likely missing permission/role hierarchy):`, e);
        });
      }

      // Write to BASE DATA sheet
      const sheetResult = await upsertBaseDataRow(discordId, {
        discord_id: discordId,
        fullname: assignment.fullname,
        nickname: assignment.nickname,
        email: assignment.email,
        roles: assignment.roleNamesForDisplay.join(', '),
        server_nickname: assignment.suggestedNickname,
      });

      pendingAssignments.delete(discordId);

      let resultNote = '';
      if (sheetResult.status === 'skipped_protected_row') {
        resultNote = '\n\n_Note: this discord_id is marked protected in BASE DATA (column A), so the sheet record was not modified, but your Discord roles/nickname WERE updated._';
      }

      await interaction.editReply({
        content: `✅ Done! Your roles and nickname have been updated.${resultNote}`,
        embeds: [],
        components: [],
      });
    } catch (err) {
      console.error('confirm_assign error:', err);
      await interaction.editReply({
        content: '❌ Something went wrong while assigning your roles. Please contact an admin.',
        embeds: [],
        components: [],
      });
    }
  }
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

(async () => {
  await registerCommands();
  await client.login(process.env.DISCORD_BOT_TOKEN);
})();
