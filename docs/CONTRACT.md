# Контракт данных backend ↔ frontend

Источник правды — pydantic-схемы `backend/bagdar/api/schemas.py`. Из них FastAPI строит
Swagger (`/docs`), а фронтенд генерирует TypeScript-типы:

```bash
cd backend && python3 scripts/export_openapi.py   # → backend/openapi.json
cd frontend && npm run gen:types                  # → src/api/schema.d.ts
```

Контрактный тест `backend/tests/test_api.py` проверяет, что реальные ответы и сообщения
потока валидируются этими схемами.

## Соглашения

- **Время** — секунды модели от 00:00 01.10.2026, часовой пояс UTC+5 (Астана).
- **Направление** — `+1` нечётное (от станции `a` к `b`, по возрастанию километра),
  `−1` чётное. Номера поездов: нечётные у нечётного направления.
- **Положение на перегоне** — `progress` от 0 до 1, всегда от станции `a` к `b`,
  независимо от направления поезда.
- **Идентификаторы**: станция `st07`, путь `st07-t2`, перегон `s07`,
  горловина `st07:A` (сторона меньшего км) / `st07:B`, светофор `sig-s07-o|e`,
  стрелка `sw-st07-t2`, поезд `t2104`.

## REST

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/api/health` | Живость сервиса |
| GET | `/api/world` | Инфраструктура и поезда с исходным расписанием (`WorldOut`) |
| GET | `/api/state` | Текущее состояние (`StateOut`) |
| GET | `/api/plan?which=current\|previous\|projected` | Действующий, предыдущий или прогнозный план: действующий, сдвинутый на текущие отклонения (`PlanOut`) |
| GET | `/api/decisions?since=&limit=` | Карточки решений (`DecisionCardOut`) |
| POST | `/api/decisions/{id}/action` | `{action: cancel\|choose, variant_id?}` — отменить B, выбрать вариант C; 409 — окно закрыто, поезд уже на перегоне, вариант недопустим |
| POST | `/api/autonomy` | `{full_auto: bool}` — переключатель «полный авто» |
| GET | `/api/index?since=` | Индекс: текущий, прогноз по плану на час, история (`IndexHistoryOut`) |
| GET | `/api/traces?since=` | Факт движения для графика: точки `[t, км]` по поездам (`TracesOut`) |
| GET | `/api/occupancy?which=current\|previous&t_from=&t_to=` | Занятость путей и перегонов для Ганта: факт до текущего момента, дальше план; `changed` — отличается в другом плане (`OccupancyOut`) |
| GET | `/api/planner` | Статус планировщика и история пересчётов: время, решатель, кандидаты, J |
| POST | `/api/plan/replan` | Пересчитать план сейчас |
| POST | `/api/events` | Внешнее событие: `{type: "train_delay", train_id, minutes}` |
| GET | `/api/events?since=&limit=&min_severity=` | Журнал событий текущего прогона |
| GET | `/api/scenarios` | Список сценариев |
| POST | `/api/sim/control` | `{action: start\|pause\|speed\|step\|reset, speed?, step_s?}` |
| POST | `/api/sim/load` | `{scenario_id?, seed?}` — новый мир, `world_version` растёт |
| GET | `/api/config` | Веса, пороги, параметры симулятора |
| GET | `/api/stream/schema` | Пример всех сообщений потока на живых данных |
| WS | `/api/stream` | Поток реального времени |

Команды идут через REST, обновления — через поток. После команды состояние приходит
в поток сразу, даже на паузе.

## Поток `/api/stream`

Подключение: `ws://host/api/stream?world_version=N&run_id=R&last_seq=M` (все параметры
необязательны).

1. `hello {protocol, run_id, world_version}`
2. `world {world}` — только если `world_version` клиента устарела.
3. `events {reset, events[]}` — если `run_id` совпадает, только пропущенные после
   `last_seq` (`reset=false`); иначе последние события с `reset=true`.
4. `decisions {reset, cards[]}` — последние карточки решений. Карточка с уже известным `id`
   приходит повторно, когда меняется её статус (отменена, выбран вариант, истекла): клиент
   заменяет её на месте.
5. `state {...}` — полный снимок динамики, включая `planner` (версия и применённая версия плана,
   решатель, статус, время пересчёта, число прогнозных конфликтов, открытые окна отмены и
   выбора `actions[]`, «полный авто», прогноз восстановления `recovery`, прогноз индекса
   `forecast`), `conflicts[]` (прогноз на час) и `index` (индекс с факторами и причинами).

Дальше `state` идёт с частотой `sim.broadcast_hz` (10 Гц в лёгком режиме), пока
симуляция идёт или что-то изменилось, `events` и `decisions` — сразу по мере появления. При загрузке
нового мира сервер сам шлёт `world`, `events(reset=true)`, `state`.

**Согласованность после обрыва.** Клиент переподключается с экспоненциальной паузой
(0,5 → 8 с) и передаёт свои `world_version/run_id/last_seq`. События дедуплицируются
по `seq`. Медленному клиенту сервер сбрасывает очередь и шлёт полную пересинхронизацию.

**Плавность.** Клиент рисует поезда с отставанием на один кадр состояния и
интерполирует положение между двумя последними кадрами — движение плавное при любой
частоте кадров браузера.

## Основные структуры

```text
WorldOut      id, mode, seed, version, scenario_id, start_time,
              zones[], stations[{id,name,kind,km,x,y,zone_id,crew_change,tracks[]}],
              sections[{id,a,b,length_km,tracks,signalling,blocks,speed_limit_kmh,
                        gradient_permille,no_stop_uphill,electrified,throat_a,throat_b}],
              signals[], switches[], classes[{key,label,pte_rank,weight,tolerance_min}],
              trains[{id,number,cls,pte_rank,direction,length_m,mass_t,passengers,cargo[],
                      traction,vmax_kmh,loco_id,crew_id,crew_shift_end,route[],sections[],
                      schedule[{station_id,arr,dep,stop,dwell_s,track_id}]}]

StateOut      run_id, world_version, seq, tick, t, running, speed,
              trains[{id,status,display,k,station_id,track_id,section_id,progress,
                      v_kmh,v_target_kmh,delay_s,wait_reason,dest_track,through,
                      next_station_id,crew_left_s,stops,unplanned_stops,stop_energy_kwh}],
              sections[{id,status,single,restriction_kmh,occupants[],dir}],
              tracks[{id,occupant,reserved,available}],
              throats[{id,holder}]  (только занятые),
              signals[{id,state}]   (только открытые и неисправные),
              metrics{active_trains,avg_delay_s,max_delay_s,on_time_share,waiting_trains,...},
              perf{step_us,tick_ms,steps_per_s,load_ms}

PlanOut       version, created_at, solver(cpsat|greedy|repair|hold), status(feasible|delayed|infeasible),
              compute_ms, notes[], cost{}, horizon_end, hold_all, held[],
              legs[{train_id,k,section_id,from_id,to_id,direction,dep,arr,track_id,stop}]

DecisionCardOut id, plan_version, t, type(crossing|overtake|track|no_plan), level(A|B|C),
              station_id, section_id, trains[], action, reason, alternative,
              cost_plan, cost_alt, delta_cost, delta_money, alt_pte_violations, alt_feasible,
              wait_min, effects[], note, full_auto,
              impact{delay_min, energy_kwh, track_load_pct, idle_pct — *_plan и *_alt},
              index_before (прогноз с альтернативой), index_after (с решением),
              status(applied|pending|proposed|cancelled|chosen|expired|superseded),
              can_cancel, can_choose, variants[{id,title,solver,valid,J,delta_money,
              late_pax,pte_violations,note}], chosen_variant, choice_card, outcome

IndexOut      t, value(0–100|null), status(norm|warning|critical|no_data), status_label,
              factors[{key,label,weight,weight_eff,score|null,available,value_text,note,lost}],
              reasons[], missing[]

OccupancyOut  which, plan_version, t, items[{resource,train_id,t0,t1,
              kind(stand|pass|section|hold),source(fact|plan),changed}]

EventOut      seq, t, kind, severity(debug|info|warn|critical), message,
              train_id?, station_id?, section_id?, data{}
```
