# План реализации

Объём: самостоятельный продукт по ARCHITECTURE.md. Источник задач и зависимостей — [plan.json](plan.json). Точная приёмка каждого этапа — [atomic-gates.json](atomic-gates.json). Начальный статус всех атомов — not_started; фактические статусы записываются в implementation-status.json. Эта спецификация не разрешает отмечать реализацию готовой до выполнения проверок.

## Маршрут

| Этап | Атомы | Проверяемый результат |
| --- | --- | --- |
| Основание | FH-00…FH-06 | Bootstrap, метамодель, linker, собственные данные плагинов и атомарная активация. |
| Исполнение | FH-07…FH-14 | Durable invocation, effects, recovery, бюджет, управление, replay и общий API/CLI. |
| Агент | FH-15…FH-18 | LLM, инструменты, проверяемый цикл и память. |
| CLI backend | FH-31 после FH-14, до FH-28 | Готовые CLI-агенты, native sessions/turns, permissions, streaming и recovery; CLI-only профиль без LLM. |
| Интерфейс и организация | FH-19…FH-25 | Вложенные UI-плагины, вопрос–ответ, история, сессии, вкладки, проекты, форки и миграции. |
| Hot reload | FH-30 после FH-27, до FH-28 | Замена каждого пакета без restart, с переносом состояния, pinned generations и rollback. |
| Приёмка | FH-26…FH-29 | Независимые расширения, эксплуатация, полная автоматическая и живая проверка. |

## Топология исходников

    packages/abi                 общие TypeScript DTO и технический SDK
    packages/host                загрузчик и техническая граница исполнения
    packages/acceptance-adapter  тонкий мост тестов к публичным API
    plugins/meta                 метатипы, validation, nominal linking
    plugins/store-sqlite         storage contract implementation
    plugins/lifecycle            stage/activation/disable/retention
    plugins/execution            Request/Invocation/Effect/Attempt/recovery/control
    plugins/api                  generic transport и subscriptions
    plugins/llm                  provider contracts и адаптер
    plugins/agent-runtime        внешние CLI/SDK/RPC агенты и native sessions
    plugins/agent-limits         необязательные политики/ограничения CLI; launch gate и свой storage
    plugins/agent-usage          необязательная статистика/usage; event observer и свой storage/UI
    plugins/tools                инструментальные типы и router
    plugins/agent                decision loop и verifier
    plugins/memory               recall/remember/provenance
    plugins/ui                  View/Action/Mount/Inspector и render bridge
    plugins/question-answer     минимальное взаимодействие
    plugins/session             Session/History и их storage/view
    plugins/tabs                контейнер вкладок и local layout
    plugins/project             Project/context/resources
    plugins/fork                ForkPlan и копирование графа
    plugins/migrations          чистое преобразование и смена Head
    apps/daemon                 локальный процесс с boot-lock
    apps/web                    минимальный shell и root mount
    apps/cli                    generic commands API client
    tests/fixtures              реальные тестовые пакеты и fake remote
    tests/e2e                   browser и restart acceptance
    tools                       build/discovery/verify commands

Межпакетные зависимости только через ABI/контракты; host не импортирует plugins. При необходимости кооперации execution/memory/session плагины вызывают объявленные операции, а не импортируют чужие приватные stores.

## Правила выполнения атома

Каждый atom.steps в plan.json — обязательная последовательность. files задают область изменения. Поле tests связывает атом с полными требованиями продукта; ранний атом не обязан исполнять поздние интеграционные варианты этой группы. Единственная поэтапная приёмка — соответствующий AT-сценарий atomic-gates.json: он явно ограничен компонентами уже завершённых зависимостей. Полные группы без пропусков обязательны в FH-28, а живая проверка — в FH-29. Это исключает скрытые циклы вроде требования recovery до его реализации.

Каждому AT соответствует tests/atoms/FH-XX.test.ts; файл включён в разрешённые изменения своего атома дополнительно к files. FH-00 подключает tsx как test-only runner с exact version в lock; npm run test:atom -- tests/atoms/FH-XX.test.ts исполняет этот файл. В нём нельзя подменять продукт результатами oracle. Тестирование адаптера напрямую в раннем AT разрешено только там, где это прямо сказано в given/when/then.

implementation-status.json создаётся в корне продукта в FH-00 и хранит для каждого ID status, startedAt, completedAt, evidence и blocker. Нельзя перезаписывать plan.json фактическим прогрессом.

Общие проверки после любого атома: typecheck затронутых workspaces, lint, соответствующий AT-сценарий, npm run spec:check. Команда npm run verify -- --atom FH-XX запускает проверки из atomic-gates.json; незарегистрированный тест или отсутствующий пакет дают ненулевой exit, а не skip. Исполнитель сохраняет stdout/stderr и exit codes в artifacts/verification/FH-XX/.

Done атома = все steps + AT gate + local dev scenario, указанный в done. Пока зависимость не done, зависимый атом не начинают. Атом с live-provider credential может быть blocked; остальные независимые проверки продолжаются. Final completion требует FH-29.

Для слабой модели рекомендуем последовательное выполнение. После каждого атома — короткий проверяемый checkpoint. Если атом не укладывается в один рабочий контекст, разбить его steps на внутренние checkpoint без изменения контрактов и dependencies; только финальный step закрывает atom.

## Контрольные решения, которые нельзя переоткрывать в коде

- Generic typed records и nominal exact ContractRef; никаких скрытых Agent/Session таблиц в host.
- Source local refs разрешаются после hash; resolved definitions не переписывают пакет.
- Per-invocation state отдельно от долговременных объектов instance.
- Одно физическое SQLite transaction domain для durable-профиля.
- Unknown external outcome не превращается в safe retry.
- Фрактальность проверяется независимым типом Checklist и сторонним badge, а не только встроенными плагинами.
- Web shell не владеет проектами/сессиями/вкладками; это отдельные пакеты.
- Стартовая конфигурация остаётся single-call даже после появления всей рабочей среды.

## Ресурсы и оценка

План содержит 32 атома; это не оценка в часах. После FH-03 и FH-10 измерить фактический throughput по завершённым атомам, включая исправления после тестов, и пересчитать прогноз. Срок по одному лишь количеству файлов не назначать. Главные риски по трудозатратам — bootstrap, crash recovery, UI plugin bundling, внешний CLI lifecycle и hot reload. IDs стабильны; порядок определяется dependencies, поэтому FH-30/FH-31 выполняются до финальных FH-28/FH-29.
