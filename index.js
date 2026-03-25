require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// Configuration
const PLAYER_ROLE_ID = '1396576572080656525';
const WELCOME_CHANNEL_ID = '1396605311300931624';
const VOICE_ROLE_ID = '1397098569734950952';
const VOICE_NOTIFICATION_CHANNEL_ID = '1396605311300931624';
const EXCLUDED_VOICE_CHANNEL_ID = '1397096857154359306';
const WAITING_CHANNEL_ID = '1396311286232518781'; // still used for player role offer

const VOICE_NOTIFICATION_COOLDOWN = 30000; // 30 seconds

const BASE_KICK_TIME = 30; // seconds

// Storage
const voiceJoinTimes = new Map();     // memberId → join timestamp
const voiceNotificationMessages = new Map(); // memberId → { message, channelId }
const lastNotifications = new Map();

const kickCounts = new Map();         // still needed for the current session countdown
const welcomeMessages = new Map();
const countdownIntervals = new Map();

// ==================== VOICE NOTIFICATIONS ====================
client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    const member = newState?.member || oldState?.member;
    if (!member) return;

    const guild = member.guild;
    const notificationChannel = guild.channels.cache.get(VOICE_NOTIFICATION_CHANNEL_ID);
    if (!notificationChannel) return;

    // === Role management ===
    if (!oldState.channelId && newState.channelId && newState.channelId !== EXCLUDED_VOICE_CHANNEL_ID) {
      await member.roles.add(VOICE_ROLE_ID).catch(console.error);
    } 
    else if (oldState.channelId && !newState.channelId && oldState.channelId !== EXCLUDED_VOICE_CHANNEL_ID) {
      await member.roles.remove(VOICE_ROLE_ID).catch(console.error);
    }
    else if (newState.channelId === EXCLUDED_VOICE_CHANNEL_ID) {
      await member.roles.remove(VOICE_ROLE_ID).catch(console.error);
    }
    else if (oldState.channelId === EXCLUDED_VOICE_CHANNEL_ID && newState.channelId) {
      await member.roles.add(VOICE_ROLE_ID).catch(console.error);
    }

    const now = Date.now();
    const lastNotif = lastNotifications.get(member.id) || 0;

    // ==================== JOIN / MOVE ====================
    if (!oldState.channelId && newState.channelId && newState.channelId !== EXCLUDED_VOICE_CHANNEL_ID) {
      if (now - lastNotif < VOICE_NOTIFICATION_COOLDOWN) return;

      const voiceChannel = guild.channels.cache.get(newState.channelId);
      const content = `**${member.user.username}** bergabung ke Voice Chat!\n${voiceChannel?.url || ''}`;

      const sentMessage = await notificationChannel.send({
        content,
        allowedMentions: { parse: [] }
      });

      voiceJoinTimes.set(member.id, now);
      voiceNotificationMessages.set(member.id, { message: sentMessage, channelId: notificationChannel.id });
      lastNotifications.set(member.id, now);

    } 
    // ==================== LEAVE / SWITCH TO EXCLUDED ====================
    else if (oldState.channelId && !newState.channelId || 
             (oldState.channelId !== EXCLUDED_VOICE_CHANNEL_ID && newState.channelId === EXCLUDED_VOICE_CHANNEL_ID)) {

      const joinTime = voiceJoinTimes.get(member.id);
      if (!joinTime) return;

      const durationMs = now - joinTime;
      const minutes = Math.floor(durationMs / 60000);
      const seconds = Math.floor((durationMs % 60000) / 1000);
      const durationStr = minutes > 0 
        ? `${minutes} menit ${seconds} detik` 
        : `${seconds} detik`;

      const data = voiceNotificationMessages.get(member.id);
      if (data) {
        try {
          await data.message.edit({
            content: `**${member.user.username}** telah keluar dari Voice Chat setelah **${durationStr}**`
          });
        } catch (e) {
          console.error('Failed to edit voice notification:', e);
        }
      }

      voiceJoinTimes.delete(member.id);
      voiceNotificationMessages.delete(member.id);
    }

  } catch (error) {
    console.error('Voice state update error:', error);
  }
});

// ==================== PLAYER ROLE OFFER (no waiting / ban) ====================
client.on('guildMemberAdd', async (member) => {
  const channel = member.guild.channels.cache.get(WAITING_CHANNEL_ID);
  if (!channel) return;

  await offerPlayerRole(member, channel, 0); // always start fresh
});

async function offerPlayerRole(member, channel, kicks) {
  const kickTime = BASE_KICK_TIME * Math.min(kicks + 1, 3);

  const embed = new EmbedBuilder()
    .setTitle('# Become Player?')
    .setDescription(`- You will be kicked in ${kickTime} seconds if not accepting\n- Kick attempts this session: ${kicks}`)
    .setColor('#FF0000');

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('accept_role')
        .setLabel('Accept Player Role')
        .setStyle(ButtonStyle.Primary)
    );

  const message = await channel.send({
    content: `${member}`,
    embeds: [embed],
    components: [row]
  });

  welcomeMessages.set(member.id, message.id);

  let secondsLeft = kickTime;
  const countdown = setInterval(async () => {
    secondsLeft--;

    try {
      const updatedEmbed = new EmbedBuilder()
        .setTitle('# Become Player?')
        .setDescription(`- You will be kicked in ${secondsLeft} seconds if not accepting\n- Kick attempts this session: ${kicks}`)
        .setColor(secondsLeft <= 5 ? '#FF0000' : '#FF6600');

      await message.edit({
        embeds: [updatedEmbed],
        components: [row]
      });

      if (secondsLeft <= 0) {
        clearInterval(countdown);
        countdownIntervals.delete(member.id);

        if (!member.roles.cache.has(PLAYER_ROLE_ID)) {
          await message.delete().catch(() => {});
          await handleKick(member);
        }
      }
    } catch (error) {
      console.error('Countdown error:', error);
      clearInterval(countdown);
    }
  }, 1000);

  countdownIntervals.set(member.id, countdown);
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton() || interaction.customId !== 'accept_role') return;

  try {
    await interaction.deferReply({ ephemeral: true });

    const member = interaction.member;
    const role = interaction.guild.roles.cache.get(PLAYER_ROLE_ID);

    if (!role) {
      return interaction.followUp({ content: 'Player role not found!', ephemeral: true });
    }

    await member.roles.add(role);

    // Reset kick count on success
    kickCounts.delete(member.id);

    // Delete the offer message
    const msgId = welcomeMessages.get(member.id);
    if (msgId) {
      try {
        const msg = await interaction.channel.messages.fetch(msgId);
        await msg.delete();
      } catch {}
    }

    // Welcome message
    const welcomeChannel = interaction.guild.channels.cache.get(WELCOME_CHANNEL_ID);
    if (welcomeChannel) {
      await welcomeChannel.send({
        content: `${member}`,
        embeds: [
          new EmbedBuilder()
            .setTitle(`Welcome ${member.user.username}!`)
            .setDescription('You now have access to the player channels!')
            .setColor('#00FF00')
        ]
      });
    }

    await interaction.followUp({ 
      content: 'You have accepted the Player role! You can now access the new player channels.', 
      ephemeral: true 
    });

    clearMemberTimers(member.id);

  } catch (error) {
    console.error('Button error:', error);
    await interaction.followUp({ content: 'An error occurred.', ephemeral: true });
  }
});

async function handleKick(member) {
  try {
    const kicks = (kickCounts.get(member.id) || 0) + 1;
    kickCounts.set(member.id, kicks);

    await member.kick(`Failed to accept role (attempt ${kicks})`);
    // No ban anymore, even at 3+
  } catch (error) {
    console.error(`Kick error for ${member.id}:`, error);
  }
}

function clearMemberTimers(memberId) {
  const countdown = countdownIntervals.get(memberId);
  if (countdown) clearInterval(countdown);
  countdownIntervals.delete(memberId);
  welcomeMessages.delete(memberId);
}

client.on('ready', () => {
  console.log(`Bot ready!`);
});

client.login(process.env.DISCORD_TOKEN);