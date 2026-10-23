// Конфигурация веб-приложения «Умный экологический мониторинг»
APP_CONFIG = {
    // Ключ HTTP Геокодера (необязателен: без него не будет адресов и поиска центра по городу).
    // Ключ JavaScript API - в index.html, в теге <script>.
    yandex: {
        geocoderKey: 'ВАШ_КЛЮЧ_ГЕОКОДЕРА'  // https://developer.tech.yandex.ru/services/
    },

    // Карта
    map: {
        city: 'Москва',              // центр по названию (нужен ключ Геокодера); иначе - center
        center: { lon: 37.64, lat: 55.76 },
        zoom: 10
    },

    // Уровни загрязнения PM2.5, мкг/м3 (цвет маркера)
    pm25: {
        elevated: 35,    // от этого значения - «повышенный» (жёлтый)
        critical: 75     // от этого значения - «критический» (красный); ниже 35 - «норма» (зелёный)
    },

    // Станция считается неактивной (серая), если данных нет дольше, мин
    // (станция шлёт раз в 60 с; в Wokwi симуляция медленнее - берём с запасом)
    staleMinutes: 5,

    // Сколько событий держать в ленте
    maxEvents: 30,

    // MQTT: браузер подключается через WebSocket
    mqtt: {
        host: 'broker.hivemq.com',
        port: 8000,              // 8000 - ws://, 8884 - wss:// (тогда useSSL: true)
        path: '/mqtt',
        useSSL: false,
        username: '',
        password: '',
        topics: {
            data:   'iot_practice/+/eco',          // данные всех станций
            alert:  'iot_practice/+/eco/alert',    // события от сервера (Node-RED)
            status: 'iot_practice/+/eco/status'    // online/offline (LWT станции)
        },
        clientIdPrefix: 'web_eco_'
    }
};
