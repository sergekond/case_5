# Умный экологический мониторинг — прототип

Итоговая задача кейса 5 (Samsung Innovation Campus, «Интернет вещей v2»).

```
 Станция (ESP32, Wokwi)                    Сервер (Node-RED)                Веб-приложение (браузер)
 DHT22, давление, PM2.5      MQTT/TCP      приём данных, пороги,  MQTT/WS   Яндекс.Карты 3.0:
 JSON раз в 60 с        ───────────────►   события (alert),  ◄──────────►  маркеры, цвет по PM2.5,
 LWT: online/offline        :1883          контроль связи         :8000    таблица параметров, события
                         └──────────────── broker.hivemq.com ───────────────┘
```

## Структура

| Папка | Что внутри |
|---|---|
| `station-wokwi/` | прошивка станции: `sketch.ino`, `diagram.json`, `libraries.txt`, кастомный чип датчика пыли `gp2y1010.chip.json` / `gp2y1010.chip.c` |
| `server-node-red/` | `flows.json` — поток для импорта в Node-RED; `src/` — код функций отдельными файлами |
| `web/` | веб-приложение: `index.html`, `css/style.css`, `js/config.js`, `js/main.js`, `js/paho-mqtt-min.js` |

## Топики MQTT

| Топик | Кто публикует | Содержимое |
|---|---|---|
| `iot_practice/<USER_ID>/eco` | станция | данные (JSON, раз в 60 с) |
| `iot_practice/<USER_ID>/eco/status` | станция (+ брокер через LWT) | `online` / `offline`, retained |
| `iot_practice/<USER_ID>/eco/alert` | сервер Node-RED | событие (JSON) |

## Формат пакета данных

```json
{
  "id": "Eco-<USER_ID>",
  "lat": 55.75580, "lon": 37.61730,
  "temperature": 22.5, "humidity": 45.0, "pressure": 1013.2, "pm25": 18.4,
  "seq": 12, "uptime_s": 720, "rssi": -60
}
```
Если датчик не ответил, поле = `null`. Без датчика давления (`HAS_PRESSURE 0`) поля `pressure` нет.

## Формат события

```json
{ "id": "Eco-<USER_ID>", "type": "pm25", "level": "critical", "severity": "critical",
  "value": 96.4, "message": "Концентрация PM2.5: КРИТИЧЕСКИЙ уровень - 96.4 мкг/м³",
  "ts": "2026-10-23T19:00:00.000Z" }
```
`type`: `pm25`, `temperature`, `humidity`, `online`, `offline`, `timeout`; `severity`: `info`, `warning`, `critical`.
События генерируются только при **смене** уровня (без повторов каждую минуту).

## Пороговые значения

| Параметр | Норма | Повышенный | Критический |
|---|---|---|---|
| PM2.5, мкг/м³ | < 35 | 35…75 | ≥ 75 |
| Температура, °C | −25…35 | вне диапазона | — |
| Влажность, % | ≤ 85 | > 85 | — |
| Связь | данные ≤ 5 мин назад | — | LWT `offline` / нет данных > 5 мин |

## Запуск

1. **Станция**: новый проект ESP32 на wokwi.com → вставить файлы из `station-wokwi/` (чип — через «+» → Custom Chip, имя `gp2y1010`) → в `sketch.ino` задать `USER_ID` → ▶.
2. **Сервер**: Node-RED → ☰ → Импорт → `server-node-red/flows.json` → Развернуть.
3. **Веб**: в папке `web/` выполнить `npx http-server -p 5500 -c-1` → открыть `http://localhost:5500`.
   Ключ JavaScript API — в `index.html` (ограничение HTTP Referer: `localhost`); ключ Геокодера (необязательно) — в `js/config.js`.
