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
const WAITING_CHANNEL_ID = '1396311286232518781';

const VOICE_NOTIFICATION_COOLDOWN = 30000; // 30 seconds
const BASE_KICK_TIME = 30; // seconds
const MAX_KICKS = 3;

const NOTIFICATION_LIFETIME = 60 * 60 * 1000; // 1 hour in milliseconds

// Storage
const kickCounts = new Map();
const waitingTimers = new Map();
const countdownIntervals = new Map();
const welcomeMessages = new Map();
const lastNotifications = new Map();

// Wait times in milliseconds (10m, 20m, 40m)
const WAIT_TIMES = [5 * 60 * 1000, 10 * 60 * 1000, 40 * 20 * 1000]; 

// Voice State Update Handler
// Voice State Update Handler with cooldown fixes and no pings
// Modified voiceStateUpdate handler with auto-cleanup
client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    const member = newState?.member || oldState?.member;
    if (!member) return;

    const guild = member.guild;
    const notificationChannel = guild.channels.cache.get(VOICE_NOTIFICATION_CHANNEL_ID);
    
    // Handle role changes immediately
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

    // Notification handling with cooldown and auto-delete
    if (notificationChannel) {
      const now = Date.now();
      const lastNotif = lastNotifications.get(member.id) || 0;
      
      if (now - lastNotif >= VOICE_NOTIFICATION_COOLDOWN) {
        let messageContent = null;
        let voiceChannel = null;

        if (!oldState.channelId && newState.channelId && newState.channelId !== EXCLUDED_VOICE_CHANNEL_ID) {
          voiceChannel = guild.channels.cache.get(newState.channelId);
          messageContent = `**${member.user.username}** bergabung ke Voice Chat!\n${voiceChannel?.url || ''}`;
        } 
        else if (oldState.channelId !== newState.channelId && newState.channelId !== EXCLUDED_VOICE_CHANNEL_ID) {
          voiceChannel = guild.channels.cache.get(newState.channelId);
          if (oldState.channelId === EXCLUDED_VOICE_CHANNEL_ID) {
            messageContent = `**${member.user.username}** memulai voice channel!\n${voiceChannel?.url || ''}`;
          } else {
            messageContent = `**${member.user.username}** berpindah ke voice channel lain!\n${voiceChannel?.url || ''}`;
          }
        }

        if (messageContent && voiceChannel) {
          lastNotifications.set(member.id, now);
          const sentMessage = await notificationChannel.send({
            content: messageContent,
            allowedMentions: { parse: [] }
          });

          // Auto-delete after 1 hour
          setTimeout(async () => {
            try {
              await sentMessage.delete();
              console.log(`Deleted notification for ${member.user.tag}`);
            } catch (error) {
              console.error('Failed to delete message:', error);
            }
          }, NOTIFICATION_LIFETIME);
        }
      }
    }
  } catch (error) {
    console.error('Voice state update error:', error);
  }
});

client.on('ready', async () => {
  console.log(`Bot ready!`);
  
  // Cleanup voice roles
  const guilds = client.guilds.cache;
  for (const [_, guild] of guilds) {
    try {
      const membersWithRole = (await guild.members.fetch()).filter(m => m.roles.cache.has(VOICE_ROLE_ID));
      for (const [_, member] of membersWithRole) {
        if (!member.voice?.channel) {
          await member.roles.remove(VOICE_ROLE_ID).catch(console.error);
        }
      }
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  }
});


client.on('guildMemberAdd', async (member) => {
  const channel = member.guild.channels.cache.get(WAITING_CHANNEL_ID);
  if (!channel) return;

  const kicks = kickCounts.get(member.id) || 0;
  
  // If user has been kicked before and is in waiting period
  if (kicks > 0 && kicks <= MAX_KICKS) {
    const waitTime = WAIT_TIMES[Math.min(kicks - 1, WAIT_TIMES.length - 1)];
    await handleWaitingPeriod(member, channel, kicks, waitTime);
    return;
  }

  // Normal flow for new users or those past waiting period
  await offerPlayerRole(member, channel, kicks);
});

async function handleWaitingPeriod(member, channel, kicks, waitTime) {
  const waitEnd = Date.now() + waitTime;
  const waitMinutes = Math.ceil(waitTime / (60 * 1000));
  
  // Initial waiting embed
  const embed = new EmbedBuilder()
    .setTitle('# Waiting Period')
    .setDescription(`You need to wait ${waitMinutes} minutes before you can try again.\n\nKick count: ${kicks}/${MAX_KICKS}`)
    .setColor('#FFA500');

  const message = await channel.send({
    content: `${member}`,
    embeds: [embed]
  });

  welcomeMessages.set(member.id, message.id);

  // Update countdown every minute until last minute
  let remainingMs = waitTime;
  const interval = setInterval(async () => {
    remainingMs -= 60000; // Subtract 1 minute
    const remainingMinutes = Math.ceil(remainingMs / (60 * 1000));

    try {
      if (remainingMinutes > 1) {
        const updatedEmbed = new EmbedBuilder()
          .setTitle('# Waiting Period')
          .setDescription(`You need to wait ${remainingMinutes} minutes before you can try again.\n\nKick count: ${kicks}/${MAX_KICKS}`)
          .setColor('#FFA500');

        await message.edit({ embeds: [updatedEmbed] });
      } else {
        // Switch to seconds countdown for last minute
        clearInterval(interval);
        startSecondsCountdown(message, member, kicks, waitEnd);
      }
    } catch (error) {
      console.error('Wait timer error:', error);
      clearInterval(interval);
    }
  }, 60000);

  waitingTimers.set(member.id, { interval, waitEnd });
}

async function startSecondsCountdown(message, member, kicks, waitEnd) {
  let remainingSeconds = Math.ceil((waitEnd - Date.now()) / 1000);
  const interval = setInterval(async () => {
    remainingSeconds--;
    
    try {
      const updatedEmbed = new EmbedBuilder()
        .setTitle('# Waiting Period Ending Soon')
        .setDescription(`You can try again in ${remainingSeconds} seconds.\n\nKick count: ${kicks}/${MAX_KICKS}`)
        .setColor('#FFA500');

      await message.edit({ embeds: [updatedEmbed] });

      if (remainingSeconds <= 0) {
        clearInterval(interval);
        await message.delete();
        const channel = message.channel;
        await offerPlayerRole(member, channel, kicks);
      }
    } catch (error) {
      console.error('Seconds countdown error:', error);
      clearInterval(interval);
    }
  }, 1000);

  // Replace the existing interval with seconds countdown
  const existingTimer = waitingTimers.get(member.id);
  if (existingTimer) clearInterval(existingTimer.interval);
  waitingTimers.set(member.id, { interval, waitEnd });
}

async function offerPlayerRole(member, channel, kicks) {
  const kickMultiplier = Math.min(kicks + 1, MAX_KICKS);
  const kickTime = BASE_KICK_TIME * kickMultiplier;

  const embed = new EmbedBuilder()
    .setTitle('# Become Player?')
    .setDescription(`- You will be kicked in ${kickTime} seconds if not accepting\n- Kick attempts: ${kicks}/${MAX_KICKS}`)
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

  // Start kick countdown
  let secondsLeft = kickTime;
  const countdown = setInterval(async () => {
    secondsLeft--;
    
    try {
      const updatedEmbed = new EmbedBuilder()
        .setTitle('# Become Player?')
        .setDescription(`- You will be kicked in ${secondsLeft} seconds if not accepting\n- Kick attempts: ${kicks}/${MAX_KICKS}`)
        .setColor(secondsLeft <= 5 ? '#FF0000' : '#FF6600');

      await message.edit({
        embeds: [updatedEmbed],
        components: [row]
      });

      if (secondsLeft <= 0) {
        clearInterval(countdown);
        countdownIntervals.delete(member.id);
        
        if (!member.roles.cache.has(PLAYER_ROLE_ID)) {
          await message.delete();
          await handleKick(member);
        }
      }
    } catch (error) {
      console.error('Kick countdown error:', error);
      clearInterval(countdown);
    }
  }, 1000);

  countdownIntervals.set(member.id, countdown);
}

// Handle button click (same as before but with kickCounts update)
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  if (interaction.customId !== 'accept_role') return;

  try {
    await interaction.deferReply({ ephemeral: true });
    
    const member = interaction.member;
    const role = interaction.guild.roles.cache.get(PLAYER_ROLE_ID);
    
    if (!role) {
      return interaction.followUp({ content: 'Player role not found!', ephemeral: true });
    }

    await member.roles.add(role);
    
    // Reset kick count on successful acceptance
    kickCounts.delete(member.id);
    
    // Delete original message
    const messageId = welcomeMessages.get(member.id);
    if (messageId) {
      try {
        const originalMessage = await interaction.channel.messages.fetch(messageId);
        await originalMessage.delete();
      } catch (error) {
        console.error('Error deleting message:', error);
      }
    }
    
    // Send welcome message
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

    // Clear timers
    clearMemberTimers(member.id);

  } catch (error) {
    console.error('Button interaction error:', error);
    await interaction.followUp({ 
      content: 'An error occurred while assigning the role.', 
      ephemeral: true 
    });
  }
});

async function handleKick(member) {
  try {
    const kicks = (kickCounts.get(member.id) || 0);
    const newKickCount = kicks + 1;
    kickCounts.set(member.id, newKickCount);

    if (newKickCount >= MAX_KICKS) {
      await member.ban({ reason: 'Maximum kick attempts reached' });
      kickCounts.delete(member.id);
    } else {
      await member.kick(`Failed to accept role (attempt ${newKickCount}/${MAX_KICKS})`);
    }
  } catch (error) {
    console.error(`Error processing kick/ban for ${member.id}:`, error);
  }
}

function clearMemberTimers(memberId) {
  const countdown = countdownIntervals.get(memberId);
  if (countdown) clearInterval(countdown);
  
  const waitTimer = waitingTimers.get(memberId);
  if (waitTimer) clearInterval(waitTimer.interval);
  
  countdownIntervals.delete(memberId);
  waitingTimers.delete(memberId);
}

client.login(process.env.DISCORD_TOKEN);