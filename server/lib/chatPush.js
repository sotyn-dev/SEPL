// Only member messages in SOTYN Chat may produce phone notifications.
function isChatPush(payload) {
  return payload?.type === 'site_chat' || payload?.type === 'chat_push_test';
}

function chatDelivery(db, groupId, messageId) {
  const group = db.prepare('SELECT * FROM chat_groups WHERE id=?').get(groupId);
  const message = db.prepare('SELECT * FROM chat_messages WHERE id=? AND group_id=?').get(messageId,groupId);
  if (!group || group.archived_at || !message || message.deleted_at || message.is_system) return null;
  const recipients = db.prepare('SELECT user_id FROM chat_group_members WHERE group_id=? AND user_id<>?')
    .all(groupId,message.sender_id).map(row=>row.user_id);
  const sender = message.sender_name || 'Someone';
  return {recipients,payload:{
    type:'site_chat',
    title:group.is_dm ? `SOTYN Chat · ${sender}` : `SOTYN Chat · ${group.name}`,
    body:`${sender}: ${message.body || (message.attachment_name ? `Attachment: ${message.attachment_name}` : 'New attachment')}`.slice(0,240),
    url:'/site-chat',tag:`chat-message-${message.id}`,
  }};
}

function notifyChat(groupId,messageId) {
  setImmediate(async()=>{
    try {
      const delivery=chatDelivery(require('../db/chatDb').getChatDb(),groupId,messageId);
      if (delivery?.recipients.length) await require('./push').pushToUsers(delivery.recipients,delivery.payload);
    } catch(err) { console.warn('[chat-push]',err.message); }
  });
}
module.exports={isChatPush,chatDelivery,notifyChat};
