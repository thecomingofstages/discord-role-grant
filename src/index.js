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
const { lookupByEmail, writeDiscordToBaseData, invalidateConfigCache, getRoleIdMap } = require('./sheets');
const { computeAssignment } = require('./assignmentLogic');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

// ---- Slash command registration ----
const commands = [
  new SlashCommandBuilder()
    .setName('register')
    .setDescription('ทีมงานใช้ command นี้เพื่อยืนยันตัวตนและรับยศใน Discord Server นี้'),
  new SlashCommandBuilder()
    .setName('refresh-roles')
    .setDescription('(Admin) Force-refresh the cached Discord role ID mapping from the CONFIG sheet.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  new SlashCommandBuilder()
    .setName('setup-register')
    .setDescription('(Admin) Post the permanent registration button in a channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('The channel to post the registration button in.')
        .setRequired(true)
    ),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
    { body: commands }
  );
  console.log('Slash commands registered.');
}

// ---- OAuth web server ----
const app = createApp({
  onGoogleEmailReceived: handleGoogleEmail,
});

app.listen(process.env.PORT, () => {
  console.log(`Auth server listening on port ${process.env.PORT}`);
});

// Stores the original /register interaction so we can followUp in the same
// channel after the OAuth redirect completes.
// discordId -> interaction
const pendingRegistrations = new Map();

// Stores computed assignment while user decides confirm/deny.
// discordId -> { assignment }
const pendingAssignments = new Map();

// ---- Slash command handler ----
client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === 'register') {
    const authUrl = `${process.env.PUBLIC_BASE_URL}/auth?discord_id=${interaction.user.id}`;

    // Save the interaction — we'll followUp on it after OAuth completes.
    pendingRegistrations.set(interaction.user.id, interaction);

    await interaction.reply({
      content:
        `## กดลิงก์ข้างล่างนี้ได้เลย\nขอให้ใช้บัญชีที่ดู Shared Drive ของ TCOS ในการลงทะเบียน ซึ่งโดยปกติจะเป็นเมลที่ให้ตอนสมัครเข้ามาครับ\n\n` +
        `${authUrl}`,
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

  if (interaction.isChatInputCommand() && interaction.commandName === 'setup-register') {
    const channel = interaction.options.getChannel('channel');

    const embed = new EmbedBuilder()
      .setTitle('สำหรับทีมงานที่เข้ามาใหม่')
      .setDescription(
        'ขอให้กดปุ่ม "ลงทะเบียน" ข้างล่างนี้ เพื่อยืนยันตัวตนทีมงานก่อนเข้าใช้ Discord Server ต่อไปครับ'
      )
      .setColor(0x2596be);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('start_register')
        .setLabel('ลงทะเบียน')
        .setStyle(ButtonStyle.Primary)
    );

    await channel.send({ embeds: [embed], components: [row] });
    await interaction.reply({
      content: `✅ Registration button posted in ${channel}.`,
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

    // Retrieve the saved /register interaction to reply in the same channel.
    const registerInteraction = pendingRegistrations.get(discordId);
    pendingRegistrations.delete(discordId);

    // Helper: send a message back to the user. Uses the channel interaction
    // if available (ephemeral followUp), otherwise falls back to DM.
    async function replyToUser(options) {
      const payload = typeof options === 'string' ? { content: options } : options;
      if (registerInteraction) {
        await registerInteraction.followUp({ ...payload, ephemeral: true });
      } else {
        const user = await client.users.fetch(discordId);
        await user.send(payload);
      }
    }

    const lookup = await lookupByEmail(email);

    if (lookup.status === 'not_found') {
      await replyToUser(
        `## ไม่พบอีเมลล์:  **${email}**\n` +
        `- กรุณาตรวจสอบอีเมลที่ให้มาอีกครั้ง\n- ถ้ายังไม่ได้ ขอให้ติดต่อขัตมอสเพื่อเพิ่ม Role ให้เองต่อไปครับ (lineid: mossyplays)`
      );
      return;
    }

    if (lookup.status === 'duplicate') {
      await replyToUser(
        `## พบอีเมลล์ที่ใช้ซ้ำ: **${email}**\n` +
        `- กรุณาติดต่อขัตมอสเพื่อเพิ่ม Role ให้เองต่อไปครับ (lineid: mossyplays)`
      );
      return;
    }

    // status === 'found'
    const assignment = await computeAssignment(lookup);

    const embed = new EmbedBuilder()
      .setTitle('ตรวจสอบข้อมูลก่อนรับยศ')
      .setColor(0x2596be)
      .addFields(
        { name: 'ชื่อ', value: assignment.fullname || '—', inline: true },
        { name: 'ชื่อเล่น', value: assignment.nickname || '—', inline: true },
        { name: 'Email', value: assignment.email || '—', inline: false },
        {
          name: '่ทีม (Role ที่จะได้รับ)',
          value: assignment.roleNamesForDisplay.length
            ? assignment.roleNamesForDisplay.map((r) => `• ${r}`).join('\n')
            : '_None_',
        },
        { name: 'ชื่อเล่น #ตำแหน่ง', value: assignment.suggestedNickname || '—' }
      );

    if (assignment.unmappedRoles.length > 0) {
      embed.addFields({
        name: '⚠️ Note',
        value: `These roles don't have a Discord role configured yet, so they won't be assigned automatically: ${assignment.unmappedRoles.join(
          ', '
        )}. An admin needs to add their role IDs to the CONFIG sheet.`,
      });
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`confirm_assign:${discordId}`)
        .setLabel('ข้อมูลถูกต้อง')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`deny_assign:${discordId}`)
        .setLabel('ยกเลิกการรับยศ')
        .setStyle(ButtonStyle.Danger)
    );

    pendingAssignments.set(discordId, { assignment });

    await replyToUser({ content: '', embeds: [embed], components: [row] });
  } catch (err) {
    console.error('handleGoogleEmail error:', err);
  }
}

// ---- Button handler ----
async function handleButtonInteraction(interaction) {
  // Permanent registration button posted by /setup-register
  if (interaction.customId === 'start_register') {
    const authUrl = `${process.env.PUBLIC_BASE_URL}/auth?discord_id=${interaction.user.id}`;
    pendingRegistrations.set(interaction.user.id, interaction);
    await interaction.reply({
      content:
        `## กดลิงก์ข้างล่างนี้ได้เลย\nขอให้ใช้บัญชีที่ดู Shared Drive ของ TCOS ในการลงทะเบียน ซึ่งโดยปกติจะเป็นเมลที่ให้ตอนสมัครเข้ามาครับ\n\n` +
        `${authUrl}`,
      ephemeral: true,
    });
    return;
  }

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
      content: 'ขอให้ติดต่อขัตมอส (lineid: mossyplays) เพื่อรับยศเองต่อไปครับ',
      embeds: [],
      components: [],
    });
    return;
  }

  if (action === 'confirm_assign') {
    const { assignment } = pending;

    // Defer immediately to avoid the 3-second Discord deadline.
    await interaction.deferUpdate();

    try {
      const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
      const member = await guild.members.fetch(discordId);

      // --- Clear previously bot-assigned roles before applying new ones ---
      // "Bot-managed roles" = any role ID that exists in the CONFIG sheet.
      const roleIdMap = await getRoleIdMap();
      const allBotRoleIds = new Set(roleIdMap.values());
      const rolesToRemove = member.roles.cache
        .filter((r) => allBotRoleIds.has(r.id))
        .map((r) => r.id);

      if (rolesToRemove.length > 0) {
        await member.roles.remove(rolesToRemove);
      }

      // --- Assign new roles ---
      if (assignment.roleIdsToAssign.length > 0) {
        await member.roles.add(assignment.roleIdsToAssign);
      }

      // --- Rename ---
      if (assignment.suggestedNickname) {
        await member.setNickname(assignment.suggestedNickname).catch((e) => {
          console.error(`Could not set nickname for ${discordId} (likely role hierarchy issue):`, e);
        });
      }

      // --- Write to BASE DATA sheet ---
      const sheetResult = await writeDiscordToBaseData(assignment.email, member.user.username, discordId);

      pendingAssignments.delete(discordId);

      let resultNote = '';
      if (sheetResult.status === 'skipped_protected_row') {
        resultNote = '\n\n_Note: this entry is marked protected in BASE DATA (column A), so the sheet record was not modified, but your Discord roles/nickname WERE updated._';
      }

      await interaction.editReply({
        content: `✅ เรียบร้อยครับ ${resultNote}`,
        embeds: [],
        components: [],
      });
    } catch (err) {
      console.error('confirm_assign error:', err);
      await interaction.editReply({
        content: '❌ พบปัญหาในการให้ยศ',
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
