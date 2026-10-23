// Контроль поступления данных: если станция молчит дольше TIMEOUT_MIN - событие.
// Запускается узлом inject каждые 30 с.

const TIMEOUT_MIN = 5;   // 5 периодов измерения (в Wokwi симуляция медленнее - с запасом)
const TIMEOUT_MS = TIMEOUT_MIN * 60 * 1000;

const seen = flow.get('lastSeen') || {};
const stale = flow.get('stale') || {};
const now = Date.now();
const out = [];

for (const [id, info] of Object.entries(seen)) {
    const isStale = now - info.ts > TIMEOUT_MS;
    if (isStale && !stale[id]) {
        out.push({
            topic: info.topic + '/alert',
            payload: {
                id: id,
                type: 'timeout',
                level: 'offline',
                severity: 'warning',
                message: `Нет данных от станции более ${TIMEOUT_MIN} мин`,
                ts: new Date().toISOString()
            }
        });
    }
    stale[id] = isStale;
}
flow.set('stale', stale);

const total = Object.keys(seen).length;
const silent = Object.values(stale).filter(Boolean).length;
node.status({ fill: silent ? 'yellow' : 'green', shape: 'ring', text: `станций: ${total}, молчат: ${silent}` });

return [out.length ? out : null];
