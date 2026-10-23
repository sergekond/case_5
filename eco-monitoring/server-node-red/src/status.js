// Статус станции из LWT: iot_practice/<USER_ID>/eco/status = "online" | "offline"
// Событие генерируется только при смене статуса.

const parts = msg.topic.split('/');          // [iot_practice, USER_ID, eco, status]
const userId = parts[1];
const id = 'Eco-' + userId;
const online = String(msg.payload).trim() === 'online';

const statuses = flow.get('online') || {};
if (statuses[id] === online) return null;    // статус не изменился
statuses[id] = online;
flow.set('online', statuses);

node.status({ fill: online ? 'green' : 'red', shape: 'dot', text: `${id}: ${online ? 'online' : 'offline'}` });

return {
    topic: `iot_practice/${userId}/eco/alert`,
    payload: {
        id: id,
        type: online ? 'online' : 'offline',
        level: online ? 'normal' : 'offline',
        severity: online ? 'info' : 'critical',
        message: online ? 'Станция на связи' : 'Станция потеряла связь с брокером (LWT)',
        ts: new Date().toISOString()
    }
};
