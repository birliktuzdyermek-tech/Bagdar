# Бағдар — промты для дизайна (Google Stitch → Figma)

Четыре промта, вставляются по очереди в один проект. В каждом не больше четырёх экранов, иначе качество падает.
Промты на английском, так генератор точнее следует инструкциям. Весь текст интерфейса задан на русском и переносится как есть.

---

## Промт 1. Основа: главная, симулятор, сценарии

```text
Design a desktop web app, 1440px wide, dark theme, called «Бағдар» — an AI assistant for railway train dispatchers. It watches a railway line, resolves train conflicts automatically and explains every decision in plain words.

The audience includes people who know nothing about railways. Every screen must be understood in 10 seconds with no training.

ALL interface text must be in Russian, exactly as written in the quotes below. Do not translate it and do not add English text.

CLARITY RULES (most important)
- Every panel title is a plain question: «Что происходит?», «Что сделал Бағдар?», «Что будет дальше?».
- One big number and one primary button per screen.
- Buttons are verbs that say what will happen.
- Every technical term has a small «?» icon next to it for a one-sentence tooltip.
- Status is always shown as word + icon + color, never color alone: «Норма» (check icon, green), «Внимание» (triangle icon, amber), «Критично» (cross icon, red).
- Never more than three red elements on one screen.
- A legend is always visible next to any diagram.
- Body text at least 16px. No thin gray text. High contrast everywhere.

STYLE
Calm control-room look, flat, no decoration, generous spacing, rounded 12px panels.
Colors: background #0B1220, panels #131C2E, borders and rail lines #2A3650, text #EEF3FB, secondary text #B4C0D6, accent #2DD4BF, green #22C55E, amber #F59E0B, red #EF4444, blue #60A5FA.
Fonts: Inter for text, JetBrains Mono for all numbers. Lines in diagrams at least 2px thick.
Train markers: circle = passenger train, rectangle = freight train, diamond = emergency train.

SHARED TOP BAR (on every screen)
Logo «Бағдар», navigation «Симулятор», «Сеть», «Сценарии», «Презентация», and a permanent small badge «Консультативный прототип — не управляет движением».

SCREEN 1 — «Главная»
- Hero headline: «Диспетчер следит за 20 поездами. Бағдар — за тысячей.»
- Subheadline: «ИИ-помощник, который находит конфликты поездов раньше, чем они случатся, и объясняет каждое решение.»
- Primary button «Запустить симуляцию», secondary button «Смотреть сценарии».
- Background: abstract glowing railway network with small moving train dots.
- Row of three stat cards: «20 поездов» / «190 пар», «100 поездов» / «4 950 пар», «1 000 поездов» / «499 500 пар». Caption under the row: «Столько пар поездов нужно проверять каждую минуту».
- Section «Как это работает» with three numbered steps and icons: «1. Видит участок целиком», «2. Находит конфликт заранее», «3. Перестраивает план и объясняет почему».
- Footer note: «Прототип на смоделированных данных».

SCREEN 2 — «Симулятор», simple mode
- Under the top bar, a control row: toggle «Простой / Эксперт» (Простой selected), clock «14:22», speed «×30», buttons «Пауза» and «Сброс».
- Large left panel «Что происходит?»: a horizontal railway line with 20 stations as labeled dots, about 12 train markers on it in the three shapes, one track section highlighted red with the label «Перегон закрыт». Legend below: «Пассажирский», «Грузовой», «Внеочередной», «Опаздывает».
- Right top panel «Состояние участка»: huge number «82», word «Норма» with green check icon, five labeled bars: «Пропускная способность», «Отклонение от графика», «Загрузка путей», «Конфликты», «Простой ресурсов». One line below: «Что тянет вниз: опоздание скорого № 12».
- Right middle panel «Что сделал Бағдар?»: a feed of three decision cards. Card example: title «Грузовой № 2104 подождёт 8 минут», text «Пропускает скорый № 12. Так дешевле на 309 у.е.», link «Почему?», button «Докажи». One card has the tag «Неочевидное решение».
- Bottom panel «Сломать что-нибудь»: six large buttons with icons: «Задержать поезд», «Сломать сигнал», «Закрыть перегон», «Отключить питание», «Буран», «Больше поездов».
- Under it a timeline scrubber labeled «Перемотка» with event markers and three counters: «Пересчёт плана: 0,4 с», «Затронуто поездов: 6», «Восстановление через 47 мин».

SCREEN 3 — «Сценарии»
- Title «Сценарии», subtitle «Ситуации, с которыми человек не справится в одиночку».
- Filter chips: «Все», «Лёгкий», «Средний», «Ультра».
- Grid of six cards. Each card: preview area with a small railway diagram, difficulty tag, title, one-line description, button «Запустить».
- Cards: «Замок» — «Четыре поезда запирают друг друга»; «Второй удар» — «Питание вернулось и снова пропало»; «Буран» — «Снежный фронт закрывает перегоны один за другим»; «Шквал тревог» — «300 сигналов за минуту»; «Тихое насыщение» — «Ничего не сломалось, но через 3 часа всё встанет»; «Эффект бабочки» — «4 минуты опоздания задели 38 поездов».
```

---

## Промт 2. Эксперт, «Докажи», человек против Бағдара

```text
Continue the same project «Бағдар» with the same design system, colors, fonts, top bar and clarity rules as the previous screens. All interface text in Russian exactly as quoted. Desktop, 1440px, dark theme.

SCREEN 4 — «Симулятор», expert mode
- Same control row, toggle «Простой / Эксперт» with Эксперт selected.
- Left column: compact railway line diagram with stations and train markers.
- Center top panel «График движения»: a time–distance chart, time on the horizontal axis, station names on the vertical axis, each train is a diagonal line. Legend: gray line «Расписание», dashed line «План», solid line «Факт». One red marker where two lines are about to cross, labeled «Конфликт через 12 мин».
- Center bottom panel «Занятость путей»: a Gantt chart with one row per track, colored blocks for trains, and a toggle «До / После».
- Right column top: decision feed «Что сделал Бағдар?» with two cards.
- Right column bottom: panel «Совет машинисту» with the text «Поезд № 2104: держать 52 км/ч, выбег через 3 км», a small speed profile curve and a green label «Экономия энергии 9 %».

SCREEN 5 — «Докажи», large modal over the simulator
- Title: «Неочевидное решение: задержать скорый № 12 на 2 минуты».
- One explaining sentence: «Смотрите, что будет через час в обоих случаях».
- Two equal side-by-side panels, each with a small railway diagram.
- Left panel «Без этого решения», red result block: «Опоздание 25 мин», «Задето 9 поездов».
- Right panel «С решением Бағдара», green result block: «Опоздание 0 мин», «Задет 1 поезд».
- Bottom bar: «Разница: 309 у.е.» and primary button «Понятно».

SCREEN 6 — «Человек против Бағдара»
- Title «Человек против Бағдара», subtitle «Один и тот же участок. 60 секунд.»
- Large timer in the center top: «00:42».
- Split screen. Left half «Вы — диспетчер»: railway diagram where each waiting train has two buttons «Пропустить» and «Задержать». Right half «Бағдар»: the same diagram, no buttons, a small label «Решает сам».
- Under each half three score rows: «Минуты задержки», «Энергия», «Условные деньги».
- Final result banner at the bottom: «Бағдар: 41 мин · Вы: 187 мин» and button «Ещё раз».
```

---

## Промт 3. Сеть, цена, телефон, слайд

```text
Continue the same project «Бағдар» with the same design system, colors, fonts, top bar and clarity rules. All interface text in Russian exactly as quoted.

SCREEN 7 — «Сеть», desktop 1440px
- Large map of a railway network split into 10 colored zones. Each zone has a badge with its index number and status word, for example «Зона 4 · 61 · Внимание». Lines between stations vary in thickness to show traffic volume.
- Zoom switch at the top of the map: «Сеть», «Регион», «Участок», «Поезд».
- Counters above the map: «Поездов: 1 000», «Диспетчеров: 10», «Пересчёт: 0,8 с».
- Small label on the map: «Стресс-тест: нагрузка выше реальной».
- Right panel «Тревоги»: headline «312 сигналов → 3 причины», then three cards: «Отказ питания на станции 14 — 212 сигналов», «Опоздание поезда № 38 — 61 сигнал», «Не связано — 39 сигналов».
- Below it panel «Что сделал Бағдар?» with two decision cards.

SCREEN 8 — «Цена», desktop 1440px
- Title «Сколько это стоит?», subtitle «Введите свои тарифы — всё пересчитается».
- Left panel «Ваши тарифы» with five input fields with units: «Цена кВт·ч», «Час локомотива», «Час бригады», «Минута задержки пассажирского», «Минута задержки грузового».
- Right: three comparison cards «Задержки», «Энергия», «Деньги». Each card has two horizontal bars labeled «Без Бағдара» and «С Бағдаром» and a large difference number.
- Bottom line: «В пересчёте на год» with a large number, and a caption «Условные единицы. Расчёт в модели.»

SCREEN 9 — «Сломайте сами», mobile 390px
- Title «Сломайте сами», subtitle «Нажмите и смотрите на большой экран».
- Six large full-width buttons with icons: «Задержать поезд», «Сломать сигнал», «Закрыть перегон», «Отключить питание», «Буран», «Больше поездов».
- Confirmation toast at the bottom: «Отправлено! Бағдар уже перестраивает план».

SCREEN 10 — presentation slide, 16:9, 1920x1080
- Very large title «Проблема».
- Three huge numbers in a row with captions: «190» / «пар при 20 поездах», «4 950» / «пар при 100 поездах», «499 500» / «пар при 1 000 поездах».
- One sentence below: «Человек уверенно следит за 5–9 объектами».
- Slide number «1 / 12» in the corner. Minimum text size 32px, nothing small.
```

---

## Промт 4. Подсказки для новичка

```text
Continue the same project «Бағдар» with the same design system. All interface text in Russian exactly as quoted. Show these as variations of the simulator screen (simple mode).

SCREEN 11 — first-visit guide
The simulator screen dimmed, with three numbered coach marks pointing at parts of the screen:
- at the railway diagram: «1. Это участок. Точки и фигуры — поезда.»
- at the panel «Сломать что-нибудь»: «2. Нажмите сюда, чтобы что-нибудь сломать.»
- at the decision feed: «3. Здесь Бағдар объясняет, что он сделал.»
Buttons «Дальше» and «Пропустить».

SCREEN 12 — tooltip and glossary
- An open tooltip next to the word «Перегон»: «Перегон — путь между двумя соседними станциями».
- A side drawer «Словарь» with a search field and a list of terms with one-line explanations: «Скрещение — встречные поезда расходятся на станции», «Обгон — быстрый поезд обходит медленный», «Индекс — оценка участка от 0 до 100», «Выбег — движение по инерции без тяги».

SCREEN 13 — projector mode
The simulator screen in a simplified large-screen variant: only the railway diagram, the index number and the latest decision card. Text at least 24px, lines 3px thick, toggle «Режим проектора» switched on.
```

---

## Короткие правки, если что-то вышло не так

Вставляются отдельным сообщением после генерации.

```text
Make all body text at least 16px and increase contrast of secondary text to #B4C0D6.
```

```text
Replace every color-only status with icon + word + color.
```

```text
Translate any remaining English interface text into Russian. Keep the quoted Russian labels exactly as given.
```

```text
Simplify this screen: keep one primary button, remove decorative elements, add more spacing.
```

```text
Use the exact same top bar, colors and fonts as Screen 2 on this screen.
```
