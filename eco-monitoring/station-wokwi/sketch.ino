// =====================================================================
//  Станция «Умный экологический мониторинг» (Samsung IoT, кейс 5, финал)
//  ESP32 (Arduino) для Wokwi
//
//  Каждые MEASURE_PERIOD_MS (60 с) измеряет:
//    - температуру и влажность      - DHT22
//    - атмосферное давление         - потенциометр (имитация датчика давления)
//    - концентрацию PM2.5           - датчик пыли GP2Y1010AU0F (кастомный чип gp2y1010)
//  и публикует JSON в iot_practice/<USER_ID>/eco:
//    {"id":"Eco-<USER_ID>","lat":..,"lon":..,"temperature":..,"humidity":..,
//     "pressure":..,"pm25":..,"seq":..,"uptime_s":..,"rssi":..}
//
//  Надёжность:
//    - Wi-Fi и MQTT переподключаются автоматически (неблокирующе), измерения не останавливаются
//    - пакеты, измеренные без связи, копятся в очереди и отправляются после восстановления
//    - LWT: брокер сам опубликует "offline" в .../eco/status, если станция пропадёт
//
//  Библиотеки (Library Manager): PubSubClient, DHT sensor library for ESPx
// =====================================================================

#include <WiFi.h>
#include <PubSubClient.h>
#include "DHTesp.h"
#include <math.h>

// ======================= НАСТРОЙКИ =======================
// ID пользователя IT Академии - замените на свой (используется в топике и ID станции)
#define USER_ID      "sergek42"

#define DEVICE_ID    "Eco-" USER_ID                       // уникальный ID станции
#define TOPIC_DATA   "iot_practice/" USER_ID "/eco"       // данные
#define TOPIC_STATUS "iot_practice/" USER_ID "/eco/status" // online/offline (LWT)

// Координаты станции (статические, задаются при конфигурации устройства)
const float STATION_LAT = 55.7558;
const float STATION_LON = 37.6173;

// Период измерений (по ТЗ - 60 с). В Wokwi симуляция часто медленнее реального времени.
const uint32_t MEASURE_PERIOD_MS = 60000;

// Датчик давления есть? (по ТЗ при отсутствии параметр допускается исключить)
#define HAS_PRESSURE 1

const char *WIFI_SSID = "Wokwi-GUEST";
const char *WIFI_PASS = "";
const char *MQTT_HOST = "broker.hivemq.com";
const uint16_t MQTT_PORT = 1883;

// ======================= ПИНЫ =======================
#define PIN_DHT       15
#define PIN_PRESSURE  35   // потенциометр (ADC1)
#define PIN_DUST_LED  16   // ILED датчика пыли
#define PIN_DUST_OUT  34   // Aout датчика пыли (ADC1 - совместим с Wi-Fi)

// ======================= ДАТЧИК ПЫЛИ =======================
// Модуль Амперки/WaveShare: ILED активен по HIGH, на выходе делитель 1:11
#define DUST_LED_ON        HIGH
#define DUST_LED_OFF       LOW
const float DUST_GAIN       = 11.0f;
const float DUST_ZERO_MV    = 600.0f;   // «чистый воздух», мВ
const float DUST_K          = 0.1724f;  // мкг/м3 на 1 мВ
const int   DUST_SAMPLES    = 10;       // импульсов в серии
const uint32_t DUST_SAMPLE_PERIOD_US = 10000;  // цикл одного импульса >= 10 мс
const uint32_t DUST_SETTLE_US        = 280;    // задержка до чтения АЦП

// ======================= ОЧЕРЕДЬ ПАКЕТОВ =======================
const int QUEUE_SIZE = 10;
char queueBuf[QUEUE_SIZE][256];
int queueHead = 0, queueCount = 0;

DHTesp dht;
WiFiClient net;
PubSubClient mqtt(net);
uint32_t seq = 0;

// ---------------------------------------------------------------
//  Измерения
// ---------------------------------------------------------------
float dustPulseMv() {
  digitalWrite(PIN_DUST_LED, DUST_LED_ON);
  delayMicroseconds(DUST_SETTLE_US);
  int raw = analogRead(PIN_DUST_OUT);
  digitalWrite(PIN_DUST_LED, DUST_LED_OFF);
  return raw * 3300.0f / 4095.0f * DUST_GAIN;
}

// Серия импульсов с усреднением -> PM2.5, мкг/м3
float measurePm25() {
  float sum = 0;
  for (int i = 0; i < DUST_SAMPLES; i++) {
    uint32_t start = micros();
    sum += dustPulseMv();
    if (i < DUST_SAMPLES - 1) {
      while (micros() - start < DUST_SAMPLE_PERIOD_US) delayMicroseconds(100);
    }
  }
  float mv = sum / DUST_SAMPLES;
  return (mv > DUST_ZERO_MV) ? DUST_K * (mv - DUST_ZERO_MV) : 0.0f;
}

// Потенциометр 0..4095 -> 950..1050 гПа (мбар)
float measurePressure() {
  return 950.0f + analogRead(PIN_PRESSURE) * 100.0f / 4095.0f;
}

// Число или null (если датчик не ответил)
void fmtNum(char *out, size_t size, float v, int prec) {
  if (isnan(v)) snprintf(out, size, "null");
  else          snprintf(out, size, "%.*f", prec, v);
}

void measureAndEnqueue() {
  TempAndHumidity th = dht.getTempAndHumidity();
  bool dhtOk = (dht.getStatus() == DHTesp::ERROR_NONE);
  if (!dhtOk) Serial.printf("[DHT] error: %s\n", dht.getStatusString());

  float pm25 = measurePm25();

  char t[16], h[16], p[16], pm[16];
  fmtNum(t, sizeof(t), dhtOk ? th.temperature : NAN, 1);
  fmtNum(h, sizeof(h), dhtOk ? th.humidity : NAN, 1);
  fmtNum(pm, sizeof(pm), pm25, 1);
#if HAS_PRESSURE
  fmtNum(p, sizeof(p), measurePressure(), 1);
#endif

  int rssi = (WiFi.status() == WL_CONNECTED) ? WiFi.RSSI() : 0;
  seq++;

  char json[256];
  snprintf(json, sizeof(json),
           "{\"id\":\"%s\",\"lat\":%.5f,\"lon\":%.5f,"
           "\"temperature\":%s,\"humidity\":%s,"
#if HAS_PRESSURE
           "\"pressure\":%s,"
#endif
           "\"pm25\":%s,\"seq\":%lu,\"uptime_s\":%lu,\"rssi\":%d}",
           DEVICE_ID, STATION_LAT, STATION_LON,
           t, h,
#if HAS_PRESSURE
           p,
#endif
           pm, (unsigned long)seq, (unsigned long)(millis() / 1000), rssi);

  // В очередь (если переполнена - теряем самый старый пакет)
  int idx = (queueHead + queueCount) % QUEUE_SIZE;
  if (queueCount == QUEUE_SIZE) {
    queueHead = (queueHead + 1) % QUEUE_SIZE;
    queueCount--;
    Serial.println("[QUEUE] full, oldest packet dropped");
  }
  strncpy(queueBuf[idx], json, sizeof(queueBuf[idx]) - 1);
  queueBuf[idx][sizeof(queueBuf[idx]) - 1] = '\0';
  queueCount++;

  Serial.printf("[MEAS] #%lu %s  (queue: %d)\n", (unsigned long)seq, json, queueCount);
}

// Отправка накопленных пакетов
void flushQueue() {
  while (queueCount > 0 && mqtt.connected()) {
    if (!mqtt.publish(TOPIC_DATA, queueBuf[queueHead])) {
      Serial.println("[MQTT] publish failed, will retry");
      return;
    }
    Serial.printf("[MQTT] -> %s\n", TOPIC_DATA);
    queueHead = (queueHead + 1) % QUEUE_SIZE;
    queueCount--;
  }
}

// ---------------------------------------------------------------
//  Сеть (неблокирующее восстановление связи)
// ---------------------------------------------------------------
bool connectMqtt() {
  String clientId = String(DEVICE_ID) + "-" + String((uint32_t)esp_random(), HEX);
  Serial.printf("[MQTT] connecting to %s as %s ... ", MQTT_HOST, clientId.c_str());
  // LWT: при обрыве брокер сам опубликует "offline" (retained)
  bool ok = mqtt.connect(clientId.c_str(), TOPIC_STATUS, 1, true, "offline");
  if (ok) {
    Serial.println("OK");
    mqtt.publish(TOPIC_STATUS, "online", true);
  } else {
    Serial.printf("failed, rc=%d\n", mqtt.state());
  }
  return ok;
}

void serviceNetwork() {
  static bool wifiStarted = false;
  static bool wasWifiConnected = false;
  static uint32_t lastWifiTry = 0, lastMqttTry = 0;
  static bool mqttTried = false;

  // --- Wi-Fi ---
  if (WiFi.status() != WL_CONNECTED) {
    if (wasWifiConnected) {
      Serial.println("[WIFI] connection lost");
      wasWifiConnected = false;
    }
    if (!wifiStarted || millis() - lastWifiTry >= 10000) {   // попытка раз в 10 с
      wifiStarted = true;
      lastWifiTry = millis();
      Serial.println("[WIFI] connecting...");
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASS, 6);
    }
    return;
  }
  if (!wasWifiConnected) {
    wasWifiConnected = true;
    Serial.printf("[WIFI] connected, IP: %s\n", WiFi.localIP().toString().c_str());
  }

  // --- MQTT ---
  if (!mqtt.connected()) {
    if (!mqttTried || millis() - lastMqttTry >= 5000) {      // попытка раз в 5 с
      mqttTried = true;
      lastMqttTry = millis();
      connectMqtt();
    }
    return;
  }

  mqtt.loop();
  flushQueue();
}

// ---------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  Serial.printf("\n=== %s, topic %s, period %lu s ===\n",
                DEVICE_ID, TOPIC_DATA, (unsigned long)(MEASURE_PERIOD_MS / 1000));

  pinMode(PIN_DUST_LED, OUTPUT);
  digitalWrite(PIN_DUST_LED, DUST_LED_OFF);

  dht.setup(PIN_DHT, DHTesp::DHT22);

  analogReadResolution(12);
  analogSetPinAttenuation(PIN_DUST_OUT, ADC_11db);
  analogSetPinAttenuation(PIN_PRESSURE, ADC_11db);

  WiFi.mode(WIFI_STA);
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(512);   // JSON ~200 байт + заголовок, стандартных 256 впритык
}

void loop() {
  serviceNetwork();

  static bool first = true;
  static uint32_t lastMeasure = 0;
  if (first || millis() - lastMeasure >= MEASURE_PERIOD_MS) {
    first = false;
    lastMeasure = millis();
    measureAndEnqueue();   // измеряем всегда, даже без связи
  }

  delay(10);
}
