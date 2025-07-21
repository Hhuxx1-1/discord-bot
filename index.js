require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent
  ]
});

// Configuration
const PLAYER_ROLE_ID = '1396576572080656525';
const WELCOME_CHANNEL_ID = '1396605311300931624';
const BASE_KICK_TIME = 20; // seconds
const MAX_KICKS = 3;

// Storage
const kickCounts = new Map(); // Tracks across sessions (consider database for persistence)
const waitingTimers = new Map(); // Tracks current waiting sessions
const countdownIntervals = new Map();
const welcomeMessages = new Map();

// Wait times in milliseconds (10m, 20m, 40m)
const WAIT_TIMES = [10 * 60 * 1000, 20 * 60 * 1000, 40 * 60 * 1000]; 

client.on('ready', () => {
  console.log(`Bot ready!`);
  // Load persistent kick counts from database here if needed
});

client.on('guildMemberAdd', async (member) => {
  const channel = member.guild.systemChannel || member.guild.channels.cache.find(ch => ch.permissionsFor(member.guild.me).has('SEND_MESSAGES'));
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