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

// ==================== CONFIG ====================
const PLAYER_ROLE_ID = '1396576572080656525';
const WELCOME_CHANNEL_ID = '1396605311300931624';
const VOICE_NOTIFICATION_CHANNEL_ID = '1396605311300931624'; // Voting goes here
const WAITING_CHANNEL_ID = '1396311286232518781';           // Status only for the user

const VOICE_ROLE_ID = '1397098569734950952';
const EXCLUDED_VOICE_CHANNEL_ID = '1397096857154359306';

const VOTE_THRESHOLD = 5;
const VOTE_EXPIRE_MS = 60 * 1000; // 1 Hour

// Storage (in-memory only - restarts will lose active votes, but we try to recover via message fetch)
const activeVotes = new Map(); // memberId → { yes: Set, no: Set, voteMsgId, statusMsgId, expireTimeout, joiner }
// ==================== VOICE JOIN / MOVE NOTIFICATIONS ====================
// This restores the old behavior: notify when someone joins or moves voice channels
// Messages stay permanently (no auto-delete) and include the voice channel link

const VOICE_NOTIFICATION_COOLDOWN = 30000; // 30 seconds cooldown per user
const lastVoiceNotifications = new Map();  // memberId → timestamp

const voiceJoinTimes = new Map();           // memberId → join timestamp (for duration)
const voiceNotificationMessages = new Map(); // memberId → { message, channelId }

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    const member = newState?.member || oldState?.member;
    if (!member) return;

    const guild = member.guild;
    const notificationChannel = guild.channels.cache.get(VOICE_NOTIFICATION_CHANNEL_ID);
    if (!notificationChannel) return;

    const now = Date.now();

    // ==================== ROLE MANAGEMENT (your original code) ====================
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

    // ==================== JOIN / SWITCH ====================
    let shouldNotify = false;
    let messageContent = null;
    let voiceChannel = null;

    if (!oldState.channelId && newState.channelId && newState.channelId !== EXCLUDED_VOICE_CHANNEL_ID) {
      // User joined voice
      voiceChannel = guild.channels.cache.get(newState.channelId);
      messageContent = `**${member.user.username}** bergabung ke Voice Chat!\n${voiceChannel?.url || ''}`;
      shouldNotify = true;

      voiceJoinTimes.set(member.id, now);                    // Save join time
    } 
    else if (oldState.channelId !== newState.channelId && newState.channelId && newState.channelId !== EXCLUDED_VOICE_CHANNEL_ID) {
      // User switched channels
      voiceChannel = guild.channels.cache.get(newState.channelId);
      if (oldState.channelId === EXCLUDED_VOICE_CHANNEL_ID) {
        messageContent = `**${member.user.username}** memulai voice channel!\n${voiceChannel?.url || ''}`;
      } else {
        messageContent = `**${member.user.username}** berpindah ke voice channel lain!\n${voiceChannel?.url || ''}`;
      }
      shouldNotify = true;

      voiceJoinTimes.set(member.id, now);   // Update join time when switching
    }

    // Send new notification if needed
    if (shouldNotify && messageContent && (now - (lastVoiceNotifications.get(member.id) || 0) >= VOICE_NOTIFICATION_COOLDOWN)) {
      lastVoiceNotifications.set(member.id, now);

      const sentMessage = await notificationChannel.send({
        content: messageContent,
        allowedMentions: { parse: [] }
      });

      voiceNotificationMessages.set(member.id, {
        message: sentMessage,
        channelId: notificationChannel.id
      });
    }

    // ==================== LEAVE DETECTION (This was missing!) ====================
    const isLeaving = (oldState.channelId && !newState.channelId) || 
                      (oldState.channelId !== EXCLUDED_VOICE_CHANNEL_ID && newState.channelId === EXCLUDED_VOICE_CHANNEL_ID);

    if (isLeaving) {
      const joinTime = voiceJoinTimes.get(member.id);
      if (!joinTime) return; // no join time recorded

      const durationMs = now - joinTime;
      const minutes = Math.floor(durationMs / 60000);
      const seconds = Math.floor((durationMs % 60000) / 1000);

      const durationText = minutes > 0 
        ? `${minutes} menit ${seconds} detik` 
        : `${seconds} detik`;

      // Edit the previous notification message
      const data = voiceNotificationMessages.get(member.id);
      if (data) {
        try {
          await data.message.edit({
            content: `**${member.user.username}** telah keluar dari Voice Chat setelah **${durationText}**`
          });
        } catch (err) {
          console.error('Failed to edit leave message:', err);
        }
      }

      // Cleanup
      voiceJoinTimes.delete(member.id);
      voiceNotificationMessages.delete(member.id);
    }

  } catch (error) {
    console.error('Voice state update error:', error);
  }
});

// ==================== READY (restart recovery - limited) ====================
client.on('ready', async () => {
  console.log(`Bot ready! Logged in as ${client.user.tag}`);

  // Optional: You can add more advanced recovery later with a database if needed
  console.log('Note: Active votes are in-memory. Long-running votes may need manual check after restart.');
});

// ==================== NEW MEMBER JOIN ====================
client.on('guildMemberAdd', async (member) => {
  const voteChannel = member.guild.channels.cache.get(VOICE_NOTIFICATION_CHANNEL_ID);
  const statusChannel = member.guild.channels.cache.get(WAITING_CHANNEL_ID);

  if (!voteChannel || !statusChannel) return;

  // Create voting embed
  const embed = new EmbedBuilder()
    .setTitle('🗳️ Let This User Join?')
    .setDescription(`**${member.user.tag}** wants to become a Player.\n\nVote below!`)
    .setColor('#00AAFF')
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vote_yes_${member.id}`).setLabel(`Yes (0/${VOTE_THRESHOLD})`).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`vote_no_${member.id}`).setLabel(`No (0/${VOTE_THRESHOLD})`).setStyle(ButtonStyle.Danger)
  );

  const voteMessage = await voteChannel.send({
    content: `Voting for ${member}`,
    embeds: [embed],
    components: [row]
  });

  // Status message in Waiting Channel (visible to the joining user)
  const statusEmbed = new EmbedBuilder()
    .setTitle('Voting In Progress')
    .setDescription(`Waiting for community votes for **${member.user.tag}**\n\nYes: 0/${VOTE_THRESHOLD} | No: 0/${VOTE_THRESHOLD}`)
    .setColor('#FFA500');

  const statusMessage = await statusChannel.send({
    content: `${member}`,
    embeds: [statusEmbed]
  });

  // Store vote data
  const voteData = {
    yes: new Set(),
    no: new Set(),
    voteMsgId: voteMessage.id,
    statusMsgId: statusMessage.id,
    voteChannelId: voteChannel.id,
    statusChannelId: statusChannel.id,
    joiner: member,
    expireTimeout: setTimeout(() => endVote(member.id, 'expire'), VOTE_EXPIRE_MS)
  };

  activeVotes.set(member.id, voteData);
});

// ==================== BUTTON VOTING ====================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const customId = interaction.customId;
  if (!customId.startsWith('vote_yes_') && !customId.startsWith('vote_no_')) return;

  const isYes = customId.startsWith('vote_yes_');
  const targetId = customId.split('_')[2];

  const voteData = activeVotes.get(targetId);
  if (!voteData) {
    return interaction.reply({ content: 'This voting has already ended.', ephemeral: true });
  }

  const voterId = interaction.user.id;
  const joinerId = targetId;

  // Prevent the joining user from voting
  if (voterId === joinerId) {
    return interaction.reply({ content: 'You cannot vote on your own application.', ephemeral: true });
  }

  // Record vote
  if (isYes) {
    voteData.yes.add(voterId);
    voteData.no.delete(voterId); // remove opposite vote if changed
  } else {
    voteData.no.add(voterId);
    voteData.yes.delete(voterId);
  }

  // Update both messages
  await updateVoteMessages(voteData);

  await interaction.reply({ content: `Your vote has been counted!`, ephemeral: true });

  // Check if threshold reached
  if (voteData.yes.size >= VOTE_THRESHOLD) {
    await approveMember(targetId);
  } else if (voteData.no.size >= VOTE_THRESHOLD) {
    await rejectMember(targetId, 'majority no');
  }
});

async function updateVoteMessages(voteData) {
  const yesCount = voteData.yes.size;
  const noCount = voteData.no.size;

  // Update voting message (in notification channel)
  try {
    const voteChannel = client.channels.cache.get(voteData.voteChannelId);
    if (voteChannel) {
      const msg = await voteChannel.messages.fetch(voteData.voteMsgId);
      const embed = msg.embeds[0];

      const newRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`vote_yes_${voteData.joiner.id}`).setLabel(`Yes (${yesCount}/${VOTE_THRESHOLD})`).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`vote_no_${voteData.joiner.id}`).setLabel(`No (${noCount}/${VOTE_THRESHOLD})`).setStyle(ButtonStyle.Danger)
      );

      await msg.edit({ embeds: [embed], components: [newRow] });
    }
  } catch (e) { console.error('Failed to update vote message:', e); }

  // Update status message (in waiting channel)
  try {
    const statusChannel = client.channels.cache.get(voteData.statusChannelId);
    if (statusChannel) {
      const statusMsg = await statusChannel.messages.fetch(voteData.statusMsgId);
      const statusEmbed = new EmbedBuilder()
        .setTitle('Voting In Progress')
        .setDescription(`Waiting for community votes for **${voteData.joiner.user.tag}**\n\nYes: ${yesCount}/${VOTE_THRESHOLD} | No: ${noCount}/${VOTE_THRESHOLD}`)
        .setColor('#FFA500');

      await statusMsg.edit({ embeds: [statusEmbed] });
    }
  } catch (e) { console.error('Failed to update status message:', e); }
}

// ==================== APPROVE / REJECT ====================
async function approveMember(memberId) {
  const data = activeVotes.get(memberId);
  if (!data) return;

  clearVote(data);

  const member = data.joiner;
  try {
    await member.roles.add(PLAYER_ROLE_ID);

    const welcomeChannel = member.guild.channels.cache.get(WELCOME_CHANNEL_ID);
    if (welcomeChannel) {
      await welcomeChannel.send({
        content: `${member}`,
        embeds: [new EmbedBuilder().setTitle(`Welcome ${member.user.username}!`).setDescription('You now have access to the player channels!').setColor('#00FF00')]
      });
    }

    // Clean status message
    try { await member.guild.channels.cache.get(data.statusChannelId)?.messages.fetch(data.statusMsgId).then(m => m.delete()); } catch {}
  } catch (err) {
    console.error('Approve error:', err);
  }
}

async function rejectMember(memberId, reason) {
  const data = activeVotes.get(memberId);
  if (!data) return;

  clearVote(data);

  const member = data.joiner;
  try {
    await member.kick(`Voting rejected (${reason})`);

    // Try DM
    try {
      await member.send('Your join request has been declined by the members. Please try again later.');
    } catch (dmErr) {
      console.log(`Could not DM ${member.user.tag} (DMs disabled or blocked)`);
    }

    // Notify in status channel
    try {
      const statusChannel = member.guild.channels.cache.get(data.statusChannelId);
      if (statusChannel) {
        await statusChannel.send(`Voting for ${member} ended. Result: **Declined**.`);
      }
    } catch {}
  } catch (err) {
    console.error('Reject error:', err);
  }
}

async function endVote(memberId, reason = 'expire') {
  const data = activeVotes.get(memberId);
  if (!data) return;

  // If neither reached 5 votes
  if (data.yes.size < VOTE_THRESHOLD && data.no.size < VOTE_THRESHOLD) {
    await rejectMember(memberId, reason);
  }
}

function clearVote(data) {
  if (data.expireTimeout) clearTimeout(data.expireTimeout);
  activeVotes.delete(data.joiner.id);
}

// ==================== USER LEAVES DURING VOTING ====================
client.on('guildMemberRemove', async (member) => {
  const data = activeVotes.get(member.id);
  if (!data) return;

  clearVote(data);

  try {
    const voteChannel = member.guild.channels.cache.get(data.voteChannelId);
    if (voteChannel) {
      await voteChannel.send(`Voting cancelled — **${member.user.tag}** left the server before voting ended.`);
    }
  } catch (e) {}
});

// Clean up on role add (safety)
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (!oldMember.roles.cache.has(PLAYER_ROLE_ID) && newMember.roles.cache.has(PLAYER_ROLE_ID)) {
    const data = activeVotes.get(newMember.id);
    if (data) clearVote(data);
  }
});

client.login(process.env.DISCORD_TOKEN);
