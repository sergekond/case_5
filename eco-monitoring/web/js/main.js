// =====================================================================
//  «Умный экологический мониторинг» - веб-приложение
//  Яндекс.Карты JS API 3.0 + MQTT (Paho, WebSocket) + HTTP Геокодер (необязательно)
//
//  Топики:
//    iot_practice/<USER_ID>/eco         - данные станции (JSON)
//    iot_practice/<USER_ID>/eco/alert   - события сервера (Node-RED)
//    iot_practice/<USER_ID>/eco/status  - online/offline (LWT станции)
//
//  JS API 3.0: координаты [ДОЛГОТА, ШИРОТА], маркер = YMapMarker с HTML-элементом
// =====================================================================

const cfg = APP_CONFIG;
const mqttConfig = cfg.mqtt;

let map = null;
const stations = {};       // ID станции -> { marker, el, label, popup, data, address, lastUpdate, online }
const addressCache = {};   // "lat,lon" -> адрес
let client = null;

/* ======================= Вспомогательное ======================= */

function setStatus(text, kind) {
    const el = document.getElementById('status');
    el.textContent = text;
    el.className = 'status status--' + kind;    // wait | ok | err
}

// Данные приходят с общего брокера - экранируем перед вставкой в HTML
function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

// Число или null
function num(x) {
    if (x === undefined || x === null || x === '') return null;
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
}

function fmt(v, unit, digits = 1) {
    return v === null ? '—' : `${v.toFixed(digits)} ${unit}`;
}

function timeStr(date) {
    return date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/* ======================= Уровень PM2.5 ======================= */

const LEVEL_NAMES = {
    normal: 'норма', elevated: 'повышенный', critical: 'критический', offline: 'нет связи'
};

function pmLevel(pm25) {
    if (pm25 === null) return 'offline';
    if (pm25 >= cfg.pm25.critical) return 'critical';
    if (pm25 >= cfg.pm25.elevated) return 'elevated';
    return 'normal';
}

/* ======================= HTTP Геокодер (необязательный) ======================= */

const geocoderEnabled = Boolean(cfg.yandex.geocoderKey);

async function geocode(query) {
    const url = 'https://geocode-maps.yandex.ru/v1/' +
        '?apikey=' + encodeURIComponent(cfg.yandex.geocoderKey) +
        '&geocode=' + encodeURIComponent(query) +
        '&lang=ru_RU&format=json&results=1';
    const response = await fetch(url);
    if (!response.ok) throw new Error('Геокодер: HTTP ' + response.status);
    const json = await response.json();
    const members = json.response.GeoObjectCollection.featureMember;
    if (!members.length) return null;
    const geo = members[0].GeoObject;
    const [lon, lat] = geo.Point.pos.split(' ').map(Number);   // "долгота широта"
    return { lon, lat, address: geo.metaDataProperty.GeocoderMetaData.text };
}

async function getAddress(lat, lon) {
    if (!geocoderEnabled) return null;
    const key = lat.toFixed(4) + ',' + lon.toFixed(4);
    if (key in addressCache) return addressCache[key];
    try {
        const r = await geocode(lon + ',' + lat);
        addressCache[key] = r ? r.address : null;
    } catch (e) {
        console.warn('Обратное геокодирование не удалось:', e.message);
        return null;
    }
    return addressCache[key];
}

/* ======================= Карта ======================= */

async function initMap() {
    await ymaps3.ready;
    const { YMap, YMapDefaultSchemeLayer, YMapDefaultFeaturesLayer } = ymaps3;

    let center = [cfg.map.center.lon, cfg.map.center.lat];
    if (geocoderEnabled && cfg.map.city) {
        try {
            const place = await geocode(cfg.map.city);
            if (place) center = [place.lon, place.lat];
        } catch (e) {
            console.warn('Геокодер недоступен, центр из config.js:', e.message);
        }
    }

    map = new YMap(document.getElementById('map'), {
        location: { center: center, zoom: cfg.map.zoom }
    });
    map.addChild(new YMapDefaultSchemeLayer());
    map.addChild(new YMapDefaultFeaturesLayer());

    // Клик по пустому месту карты закрывает открытые окна
    document.getElementById('map').addEventListener('click', () => {
        Object.values(stations).forEach(s => s.el.classList.remove('station--open'));
    });

    console.log('Карта загружена');
}

/* ======================= Маркеры станций ======================= */

function createStation(id, coords) {
    const el = document.createElement('div');
    const popup = document.createElement('div');
    const label = document.createElement('div');
    popup.className = 'station__popup';
    label.className = 'station__label';
    el.append(popup, label);

    label.addEventListener('click', (e) => {
        e.stopPropagation();
        el.classList.toggle('station--open');
    });
    popup.addEventListener('click', (e) => e.stopPropagation());

    const marker = new ymaps3.YMapMarker({ coordinates: coords }, el);
    map.addChild(marker);

    const st = { marker, el, label, popup, data: null, address: null, lastUpdate: null, online: true };
    stations[id] = st;
    updateCounter();
    console.log('Новая станция:', id);
    return st;
}

function isStale(st) {
    if (!st.lastUpdate) return true;
    return Date.now() - st.lastUpdate.getTime() > cfg.staleMinutes * 60 * 1000;
}

// Перерисовать маркер и окно станции по сохранённым данным
function renderStation(id) {
    const st = stations[id];
    const d = st.data;
    const inactive = !st.online || isStale(st);
    const level = inactive ? 'offline' : pmLevel(d.pm25);

    const open = st.el.classList.contains('station--open');
    st.el.className = 'station level--' + level + (open ? ' station--open' : '');

    st.label.textContent = d.pm25 === null ? id : `${id} · ${d.pm25.toFixed(0)}`;
    st.label.title = `${id}: PM2.5 ${fmt(d.pm25, 'мкг/м³')}`;

    const pmBadgeLevel = pmLevel(d.pm25);
    st.popup.innerHTML = `
        <div class="popup__title">Станция ${escapeHtml(id)}</div>
        ${st.address ? `<div class="popup__address">${escapeHtml(st.address)}</div>` : ''}
        <table class="popup__table">
            <tr><td>Температура</td><td>${fmt(d.temperature, '°C')}</td></tr>
            <tr><td>Влажность</td><td>${fmt(d.humidity, '%')}</td></tr>
            <tr><td>Давление</td><td>${fmt(d.pressure, 'мбар')}</td></tr>
            <tr><td>PM2.5</td><td>${fmt(d.pm25, 'мкг/м³')}
                <span class="popup__badge level--${pmBadgeLevel}">${LEVEL_NAMES[pmBadgeLevel]}</span></td></tr>
        </table>
        <div class="popup__time">Обновлено: ${timeStr(st.lastUpdate)}</div>
        ${inactive ? `<div class="popup__offline">${st.online ? 'Данные устарели' : 'Станция не на связи'}</div>` : ''}
    `;
}

async function processStationData(topic, payload) {
    // ID: из пакета (Eco-USER_ID), иначе - из топика
    const userId = topic.split('/')[1];
    const id = typeof payload.id === 'string' && payload.id ? payload.id : 'Eco-' + userId;

    const lat = num(payload.lat);
    const lon = num(payload.lon);
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        console.warn('Нет корректных координат у станции', id, payload);
        return;
    }
    const coords = [lon, lat];   // [долгота, широта]

    let st = stations[id];
    if (!st) st = createStation(id, coords);
    else st.marker.update({ coordinates: coords });

    st.data = {
        temperature: num(payload.temperature),
        humidity: num(payload.humidity),
        pressure: num(payload.pressure),
        pm25: num(payload.pm25)
    };
    st.lastUpdate = new Date();
    st.online = true;
    st.topicUser = userId;
    renderStation(id);

    // Адрес станции (кешируется, запрос к Геокодеру только для новых координат)
    const address = await getAddress(lat, lon);
    if (address && address !== st.address) {
        st.address = address;
        renderStation(id);
    }
}

function processStatus(topic, text) {
    const id = 'Eco-' + topic.split('/')[1];
    const st = stations[id];
    if (!st) return;                      // станция ещё не присылала данные
    st.online = text.trim() === 'online';
    renderStation(id);
}

// Периодически: станции без свежих данных становятся серыми
setInterval(() => {
    Object.keys(stations).forEach(id => {
        if (stations[id].data) renderStation(id);
    });
    updateCounter();
}, 15000);

function updateCounter() {
    const all = Object.values(stations);
    const active = all.filter(s => s.online && !isStale(s)).length;
    document.getElementById('stations-count').textContent = `Станций: ${all.length}, активных: ${active}`;
}

/* ======================= Лента событий ======================= */

const events = [];

function addEvent(ev) {
    events.unshift(ev);
    if (events.length > cfg.maxEvents) events.pop();

    const list = document.getElementById('events-list');
    list.innerHTML = '';
    for (const e of events) {
        const li = document.createElement('li');
        li.className = 'sev--' + (['info', 'warning', 'critical'].includes(e.severity) ? e.severity : 'info');
        const time = e.ts ? new Date(e.ts) : new Date();
        li.innerHTML = `<div class="ev-time">${timeStr(isNaN(time) ? new Date() : time)} · ${escapeHtml(e.id || '')}</div>` +
                       `<div>${escapeHtml(e.message || JSON.stringify(e))}</div>`;
        list.appendChild(li);
    }
}

/* ======================= MQTT ======================= */

function onMessageArrived(message) {
    const topic = message.destinationName;
    const text = message.payloadString;
    try {
        if (topic.endsWith('/eco')) {
            processStationData(topic, JSON.parse(text));
        } else if (topic.endsWith('/eco/alert')) {
            addEvent(JSON.parse(text));
        } else if (topic.endsWith('/eco/status')) {
            processStatus(topic, text);
        }
    } catch (e) {
        console.error('Ошибка обработки сообщения из', topic, e);
    }
}

function connectAndSubscribe() {
    setStatus('MQTT: подключение…', 'wait');
    const options = {
        useSSL: mqttConfig.useSSL,
        timeout: 10,
        keepAliveInterval: 30,
        cleanSession: true,
        onSuccess: () => {
            console.log('Подключено к MQTT');
            Object.values(mqttConfig.topics).forEach(t => client.subscribe(t, {
                onSuccess: () => console.log('Подписано на:', t)
            }));
            setStatus('MQTT: подключено', 'ok');
        },
        onFailure: (e) => {
            console.error('Ошибка подключения:', e.errorMessage);
            setStatus('MQTT: нет связи, повтор…', 'err');
            setTimeout(connectAndSubscribe, 5000);
        }
    };
    if (mqttConfig.username) {
        options.userName = mqttConfig.username;
        options.password = mqttConfig.password;
    }
    client.connect(options);
}

function initMqtt() {
    const clientId = mqttConfig.clientIdPrefix + Math.random().toString(36).slice(2);
    client = new Paho.MQTT.Client(mqttConfig.host, Number(mqttConfig.port), mqttConfig.path, clientId);
    client.onConnectionLost = (r) => {
        console.log('Соединение потеряно:', r.errorMessage);
        setStatus('MQTT: соединение потеряно, повтор…', 'err');
        setTimeout(connectAndSubscribe, 3000);
    };
    client.onMessageArrived = onMessageArrived;
    connectAndSubscribe();
}

/* ======================= Запуск ======================= */

function fillLegend() {
    const p = cfg.pm25;
    document.getElementById('legend-normal').textContent   = `норма: < ${p.elevated} мкг/м³`;
    document.getElementById('legend-elevated').textContent = `повышенный: ${p.elevated}–${p.critical}`;
    document.getElementById('legend-critical').textContent = `критический: ≥ ${p.critical}`;
}

async function main() {
    fillLegend();
    try {
        await initMap();
        initMqtt();      // MQTT только после карты: иначе маркеры некуда ставить
    } catch (e) {
        console.error(e);
        setStatus('Ошибка: ' + e.message, 'err');
    }
}

main();
