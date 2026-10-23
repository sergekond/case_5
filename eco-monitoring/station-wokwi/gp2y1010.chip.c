// Wokwi Custom Chip - имитация модуля датчика пыли Sharp GP2Y1010AU0F
// (вариант «модуль Амперки/WaveShare»: ILED активен по HIGH, на выходе делитель 1:11)
//
// Выводы:
//   VCC - питание (если не подано, выход = 0)
//   GND - земля
//   IN  - ILED, включение ИК-светодиода (HIGH = вкл)
//   OUT - Aout, аналоговый выход
//
// Поведение:
//   - пока LED выключен, выход ~0 В;
//   - после включения LED выходное напряжение плавно нарастает
//     и через ~280 мкс выходит на уровень, зависящий от запылённости;
//   - напряжение датчика: U = 0.6 В + dust / 172.4 (насыщение 3.7 В), затем делитель 1:11;
//   - предупреждения в консоли, если LED горит дольше 1 мс
//     или импульсы идут чаще, чем раз в 10 мс.
//
// SPDX-License-Identifier: MIT
// Copyright 2026 Sergek

#include "wokwi-api.h"
#include <stdio.h>
#include <stdlib.h>
#include <stdbool.h>

#define V_CLEAR        0.6f      // напряжение «чистого воздуха», В
#define K_UG_PER_V     172.4f    // мкг/м3 на 1 В
#define V_SAT          3.7f      // насыщение выхода датчика, В
#define DIVIDER        11.0f     // делитель на плате модуля
#define STEP_US        20        // шаг моделирования переходного процесса, мкс
#define ALPHA          0.35f     // за 14 шагов (280 мкс) выход доходит до ~99.8 %
#define LED_MAX_ON_NS  1000000ULL  // 1 мс - дольше держать LED нельзя
#define MIN_PERIOD_NS  9000000ULL  // минимальный период импульсов (с запасом от 10 мс)

typedef struct {
  pin_t    pin_vcc;
  pin_t    pin_gnd;
  pin_t    pin_in;
  pin_t    pin_out;
  uint32_t attr_dust;
  uint32_t attr_noise;
  uint32_t timer;
  float    v_sensor;    // текущее напряжение датчика (до делителя), В
  float    v_target;    // установившееся значение для текущего импульса, В
  bool     led_on;
  bool     long_on_warned;
  uint64_t t_on;        // время включения LED, нс
  uint64_t t_prev_on;   // время предыдущего включения, нс
  uint32_t pulses;
} chip_state_t;

static void update_output(chip_state_t *chip) {
  float v = chip->v_sensor;
  if (!pin_read(chip->pin_vcc)) {
    v = 0.0f;  // нет питания - нет сигнала
  }
  pin_dac_write(chip->pin_out, v / DIVIDER);
}

static float calc_target(chip_state_t *chip) {
  float dust  = attr_read_float(chip->attr_dust);
  float noise = attr_read_float(chip->attr_noise);

  // случайный шум в диапазоне [-noise; +noise]
  float r = ((float)rand() / (float)RAND_MAX) * 2.0f - 1.0f;
  dust += noise * r;
  if (dust < 0.0f) dust = 0.0f;

  float v = V_CLEAR + dust / K_UG_PER_V;
  if (v > V_SAT) v = V_SAT;
  return v;
}

static void on_timer(void *user_data) {
  chip_state_t *chip = (chip_state_t *)user_data;

  // апериодическое звено первого порядка
  chip->v_sensor += (chip->v_target - chip->v_sensor) * ALPHA;

  if (chip->led_on) {
    uint64_t on_time = get_sim_nanos() - chip->t_on;
    if (on_time > LED_MAX_ON_NS && !chip->long_on_warned) {
      printf("[GP2Y1010] WARNING: IR LED is ON for more than 1 ms! It must be pulsed.\n");
      chip->long_on_warned = true;
    }
  } else if (chip->v_sensor < 0.001f) {
    chip->v_sensor = 0.0f;
    timer_stop(chip->timer);
  }

  update_output(chip);
}

static void on_led_change(void *user_data, pin_t pin, uint32_t value) {
  chip_state_t *chip = (chip_state_t *)user_data;
  uint64_t now = get_sim_nanos();

  if (value) {
    // LED включён
    if (chip->pulses > 0 && (now - chip->t_prev_on) < MIN_PERIOD_NS) {
      printf("[GP2Y1010] WARNING: pulse period %.2f ms < 10 ms\n",
             (double)(now - chip->t_prev_on) / 1e6);
    }
    chip->t_prev_on      = now;
    chip->t_on           = now;
    chip->led_on         = true;
    chip->long_on_warned = false;
    chip->pulses++;
    chip->v_target       = calc_target(chip);
  } else {
    // LED выключен - сигнал спадает
    chip->led_on   = false;
    chip->v_target = 0.0f;
  }

  timer_start(chip->timer, STEP_US, true);
}

void chip_init() {
  chip_state_t *chip = malloc(sizeof(chip_state_t));

  chip->pin_vcc = pin_init("VCC", INPUT);
  chip->pin_gnd = pin_init("GND", INPUT);
  chip->pin_in  = pin_init("IN",  INPUT);
  chip->pin_out = pin_init("OUT", ANALOG);

  chip->attr_dust  = attr_init_float("dust", 50.0f);
  chip->attr_noise = attr_init_float("noise", 10.0f);

  chip->v_sensor       = 0.0f;
  chip->v_target       = 0.0f;
  chip->led_on         = false;
  chip->long_on_warned = false;
  chip->t_on           = 0;
  chip->t_prev_on      = 0;
  chip->pulses         = 0;

  const timer_config_t timer_config = {
    .callback  = on_timer,
    .user_data = chip,
  };
  chip->timer = timer_init(&timer_config);

  const pin_watch_config_t watch_config = {
    .edge       = BOTH,
    .pin_change = on_led_change,
    .user_data  = chip,
  };
  pin_watch(chip->pin_in, &watch_config);

  update_output(chip);
  printf("[GP2Y1010] Dust sensor module simulation started\n");
}
