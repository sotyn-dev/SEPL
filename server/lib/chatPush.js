// Chat push notification handler with mention and DM routing.
const { createNotification } = require('../services/notificationService');

function isChatPush(payload) {
  return payload?.type === 'site_chat' || payload?.type === 'chat_push_test' || payload?.type === 'site_call' || payload?.type === 'chat_mention' || payload?.type === 'chat_dm';
}

function extractMentionedUserIds(body, members) {
  if (!body || !members || !members.length) return [];
  const text = String(body).toLowerCase();
  if (text.includes('@all') || text.includes('@everyone')) {
    return members.map(m => m.user_id);
  }
  const mentioned = new Set();
  for (const m of members) {
    const fullName = String(m.user_name || '').trim().toLowerCase();
    const firstName = fullName.split(' ')[0];
    if (fullName && text.includes(`@${fullName}`)) {
      mentioned.add(m.user_id);
    } else if (firstName && firstName.length >= 3 && text.includes(`@${firstName}`)) {
      mentioned.add(m.user_id);
    }
  }
  return Array.from(mentioned);
}

function notifyChat(groupId, messageId) {
  setImmediate(async () => {
    try {
      const db = require('../db/chatDb').getChatDb();
      const group = db.prepare('SELECT * FROM chat_groups WHERE id=?').get(groupId);
      const message = db.prepare('SELECT * FROM chat_messages WHERE id=? AND group_id=?').get(messageId, groupId);
      if (!group || group.archived_at || !message || message.deleted_at || message.is_system) return;

      const sender = message.sender_name || 'Someone';
      const preview = `${message.body || (message.attachment_name ? `Attachment: ${message.attachment_name}` : 'New attachment')}`.slice(0, 240);

      const members = db.prepare('SELECT user_id, user_name FROM chat_group_members WHERE group_id=? AND user_id<>?')
        .all(groupId, message.sender_id);

      if (group.is_dm) {
        // Direct Message: Notify the recipient
        const recipient = members[0];
        if (recipient) {
          await createNotification({
            userId: recipient.user_id,
            type: 'chat_dm',
            title: `DM from ${sender}`,
            body: `${sender}: ${preview}`,
            referenceType: 'chat',
            referenceId: Number(groupId),
            actionUrl: `/site-chat?chat=${Number(groupId)}`,
            priority: 'normal',
            dedupeKey: `dm_${message.id}_${recipient.user_id}`,
            module: 'Chat'
          });
        }
      } else {
        // Group Chat: Notify only mentioned members
        const mentionedIds = extractMentionedUserIds(message.body, members);
        if (mentionedIds.length > 0) {
          for (const uid of mentionedIds) {
            await createNotification({
              userId: uid,
              type: 'chat_mention',
              title: `Mentioned in ${group.name}`,
              body: `${sender}: ${preview}`,
              referenceType: 'chat',
              referenceId: Number(groupId),
              actionUrl: `/site-chat?chat=${Number(groupId)}&msg=${message.id}`,
              priority: 'high',
              dedupeKey: `mention_${message.id}_${uid}`,
              module: 'Chat'
            });
          }
        }
      }
    } catch (err) {
      console.warn('[chat-push] notifyChat error:', err.message);
    }
  });
}

function callNotification(call) {
  return {
    type: 'site_call',
    callId: call.callId,
    expiresAt: call.expiresAt,
    receiptToken: call.receiptToken,
    title: `SOTYN · Incoming ${call.video ? 'video' : 'voice'} call`,
    body: `${call.fromName || 'Someone'} is calling. Tap to open SOTYN and answer.`,
    url: `/site-chat?call=${encodeURIComponent(call.callId)}`,
    tag: `sotyn-call-${call.callId}`,
    requireInteraction: true,
  };
}

function notifyCall(call) {
  return require('./push').pushToUser(call.to, callNotification(call));
}

module.exports = {
  isChatPush,
  notifyChat,
  callNotification,
  notifyCall,
  extractMentionedUserIds
};
