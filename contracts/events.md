# События версии 1

Каждая запись имеет обязательные поля `seq` (порядковый номер в прогоне), `t` (секунды модели), `kind`, `severity` (`debug`, `info`, `warn`, `critical`), `message`, `train_id`, `station_id`, `section_id`, `data`. Идентификаторы могут быть `null`; `data` — объект. Время и идентификаторы имеют те же правила, что в `README.md`. Записи неизменяемы, сортировка — по `seq`.

| `kind` | Когда возникает | Контекст и `data` |
| --- | --- | --- |
| `scenario_loaded` | Загружен новый мир и график | `message` содержит сценарий, seed и число поездов; ссылки `null`, `data: {}` |
| `sim_control` | Старт, пауза, скорость или шаг | `data.action`, `data.speed`; ссылки `null` |
| `train_spawned` | Поезд готов на начальной станции | `train_id`, `station_id` |
| `train_departed` | Поезд отправился на перегон | `train_id`, `station_id`, `section_id` |
| `train_passed` | Поезд прошёл промежуточную станцию | `train_id`, `station_id` |
| `train_arrived` | Поезд прибыл на станцию | `train_id`, `station_id` |
| `train_held` | Поезд удержан у станции или на перегоне | `train_id`, одна из ссылок на ресурс; причина в `message` |
| `train_delay` | Задержка превысила допуск класса | `train_id`, `data.delay_s` |
| `train_recovered` | Поезд вернулся в допуск | `train_id`, `data.delay_s` |
| `train_finished` | Поезд завершил работу на участке | `train_id` |

Типы выше существуют в текущем движке. События сбоев и перепланирования появятся в следующих этапах. Их нельзя изображать как состоявшиеся, пока движок не создаёт их. Потребитель должен принимать неизвестный `kind` и показывать `message`.

Примеры из `examples/replay.light.json`:

```json
{"seq":1,"t":21600.0,"kind":"scenario_loaded","severity":"info","message":"Загружен сценарий «Штатное движение», seed 42: 94 поездов в графике","train_id":null,"station_id":null,"section_id":null,"data":{}}
```

```json
{"seq":2,"t":21616.0,"kind":"train_arrived","severity":"debug","message":"Поезд 2013 прибыл на ст. Разъезд 7","train_id":"t2013","station_id":"st07","section_id":null,"data":{}}
```

Поля второго примера сверяются с экспортом при проверке пакета; если seed-генератор изменится, перегенерировать и этот пример.
