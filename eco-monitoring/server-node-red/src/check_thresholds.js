// Приём пакета станции, проверка данных и контроль пороговых значений.
// Выход 1 -> события (alert) в iot_practice/<USER_ID>/eco/alert
// Выход 2 -> краткая сводка для отладки

// ---------- Пороговые значения ----------
const T = {
    pm25:        { elevated: 35, critical: 75 },   // мкг/м3: норма < 35 <= повышенный < 75 <= критический
    temperature: { min: -25, max: 35 },            // °C
    humidity:    { max: 85 }                       // %
};

const d = msg.payload;

// ---------- Проверка формата ----------
if (typeof d !== 'object' || d === null || typeof d.id !== 'string') {
    node.warn('Некорректный пакет в ' + msg.topic + ': ' + JSON.stringify(d));
    return null;
}
const id = d.id;
const now = new Date();

// Время последнего пакета - для контроля «станция пропала» (watchdog)
const seen = flow.get('lastSeen') || {};
seen[id] = { ts: now.getTime(), topic: msg.topic };
flow.set('lastSeen', seen);

// ---------- Уровни параметров ----------
function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }

function pmLevel(v) {
    if (v === null) return 'unknown';
    if (v >= T.pm25.critical) return 'critical';
    if (v >= T.pm25.elevated) return 'elevated';
    return 'normal';
}
function tempLevel(v) {
    if (v === null) return 'unknown';
    if (v > T.temperature.max) return 'high';
    if (v < T.temperature.min) return 'low';
    return 'normal';
}
function humLevel(v) {
    if (v === null) return 'unknown';
    return v > T.humidity.max ? 'high' : 'normal';
}

const values = { pm25: num(d.pm25), temperature: num(d.temperature), humidity: num(d.humidity) };
const levels = {
    pm25: pmLevel(values.pm25),
    temperature: tempLevel(values.temperature),
    humidity: humLevel(values.humidity)
};

const NAMES = { pm25: 'Концентрация PM2.5', temperature: 'Температура', humidity: 'Влажность' };
const UNITS = { pm25: 'мкг/м³', temperature: '°C', humidity: '%' };
const LEVEL_TEXT = {
    normal: 'в норме', elevated: 'повышенный уровень', critical: 'КРИТИЧЕСКИЙ уровень',
    high: 'выше нормы', low: 'ниже нормы'
};
function severity(level) {
    if (level === 'critical') return 'critical';
    if (level === 'normal') return 'info';
    return 'warning';
}

// ---------- Событие - только при СМЕНЕ уровня (без спама каждую минуту) ----------
const state = flow.get('levels') || {};
const prev = state[id] || {};
const alerts = [];
const alertTopic = msg.topic + '/alert';

for (const key of Object.keys(levels)) {
    const cur = levels[key];
    const was = prev[key] || 'normal';
    if (cur === 'unknown' || cur === was) continue;

    const text = cur === 'normal' && was !== 'normal'
        ? `${NAMES[key]} вернулась в норму: ${values[key]} ${UNITS[key]}`
        : `${NAMES[key]}: ${LEVEL_TEXT[cur]} - ${values[key]} ${UNITS[key]}`;

    alerts.push({
        topic: alertTopic,
        payload: {
            id: id,
            type: key,
            level: cur,
            severity: severity(cur),
            value: values[key],
            message: text,
            ts: now.toISOString()
        }
    });
}
state[id] = Object.assign({}, prev, ...Object.keys(levels)
    .filter(k => levels[k] !== 'unknown')
    .map(k => ({ [k]: levels[k] })));
flow.set('levels', state);

// ---------- Статус узла и сводка ----------
const colors = { normal: 'green', elevated: 'yellow', critical: 'red', unknown: 'grey' };
node.status({
    fill: colors[levels.pm25],
    shape: 'dot',
    text: `${id}: PM2.5 ${values.pm25 ?? '-'}, ${values.temperature ?? '-'}°C, ${now.toLocaleTimeString()}`
});

const summary = {
    payload: `${id}: t=${values.temperature}°C, h=${values.humidity}%, p=${num(d.pressure)} мбар, ` +
             `PM2.5=${values.pm25} (${levels.pm25}), событий: ${alerts.length}`
};

return [alerts.length ? alerts : null, summary];
