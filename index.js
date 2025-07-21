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
const SecondKick = 20;
const MAX_KICKS = 3;

const kickCounts = new Map();
const kickTimers = new Map();
const countdownIntervals = new Map();
const welcomeMessages = new Map();

client.on('ready', () => {
  console.log(`Bot ready!`);
});

client.on('guildMemberAdd', async (member) => {
  const channel = member.guild.systemChannel || member.guild.channels.cache.find(ch => ch.permissionsFor(member.guild.me).has('SEND_MESSAGES'));
  
  if (!channel) return;

  // Create welcome message with button
  const embed = new EmbedBuilder()
    .setTitle('# Become Player?')
    .setDescription(`- You will be kicked in ${SecondKick} seconds if not accepting`)
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

  // Start countdown
  let secondsLeft = SecondKick + 1;
  const countdown = setInterval(async () => {
    secondsLeft--;
    
    try {
      const updatedEmbed = new EmbedBuilder()
        .setTitle('# Become Player?')
        .setDescription(`- You will be kicked in ${secondsLeft} seconds if not accepting`)
        .setColor('#FF0000');

      await message.edit({
        embeds: [updatedEmbed],
        components: [row]
      });

      if (secondsLeft <= 0) {
        clearInterval(countdown);
        countdownIntervals.delete(member.id);
        
        if (!member.roles.cache.has(PLAYER_ROLE_ID)) {
          await message.delete(); // Delete the original embed
          await handleKick(member);
        }
      }
    } catch (error) {
      console.error('Countdown error:', error);
      clearInterval(countdown);
    }
  }, 1000);

  countdownIntervals.set(member.id, countdown);
});

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
    
    // Get and delete the original message
    const messageId = welcomeMessages.get(member.id);
    if (messageId) {
      try {
        const originalMessage = await interaction.channel.messages.fetch(messageId);
        await originalMessage.delete();
      } catch (error) {
        console.error('Error deleting message:', error);
      }
    }
    
    // Send welcome message to designated channel
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

    // Update interaction response
    await interaction.followUp({ 
      content: 'You have accepted the Player role! You can now access the new player channels.', 
      ephemeral: true 
    });

    // Clear any existing timers
    const countdown = countdownIntervals.get(member.id);
    if (countdown) {
      clearInterval(countdown);
      countdownIntervals.delete(member.id);
    }
    
    const kickTimer = kickTimers.get(member.id);
    if (kickTimer) {
      clearTimeout(kickTimer);
      kickTimers.delete(member.id);
    }

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
    kickCounts.set(member.id, kicks + 1);

    if (kicks + 1 >= MAX_KICKS) {
      await member.ban({ reason: 'Repeated failure to accept Player role' });
      kickCounts.delete(member.id);
    } else {
      await member.kick('Did not accept Player role in time');
    }
  } catch (error) {
    console.error(`Error processing kick/ban for ${member.id}:`, error);
  }
}

client.login(process.env.DISCORD_TOKEN);