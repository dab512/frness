# FRNESS: инструкция агенту-разработчику

Этот файл — рабочая инструкция для агента, запущенного через FRNESS. Выполняй конкретную задачу пользователя, проверяй результат и коммить законченные изменения. Полный roadmap не является заданием реализовать всё.

## 1. Цель архитектуры

FRNESS начинается с запуска LLM или CLI-агента. Предметные сущности, поведение и хранение определяются плагинами. У плагина есть метаописания, реализация, конфигурация, собственные namespaces и явно объявленные слоты. Плагин может прикреплять другие плагины; реализацию одного контракта можно заменить деревом, сохранив внешний контракт.

Не добавляй Session, Project, Memory и другие предметные таблицы/ветвления в `packages/host`. Host проверяет и загружает закреплённые определения и технические ABI. Лимиты и статистика CLI — отдельные плагины, не обязательные поля ядра.

Текущий стек: Node 24, TypeScript strict/NodeNext, esbuild, Ajv, SQLite/better-sqlite3; Electron содержит локальный renderer и запускает Node worker. Для UI нет отдельного HTTP-сервера.

## 2. Рабочий цикл внутри FRNESS

Из корня checkout:

```sh
npm ci
npm run desktop -- --workspace /absolute/path/to/frness
```

Или задачу из файла:

```sh
npm run selfhost -- --provider codex --workspace . --prompt-file TASK.md
```

В TASK.md укажи: цель одного плагина, вход/выход, точку прикрепления, принадлежность данных, допустимые эффекты, конкретные проверки. Установленный CLI должен быть авторизован. Не принимай текст «готово» за доказательство записи файлов: проверь diff, тест и реальные записи/эффекты. `completed` означает завершение native turn, а не успешную реализацию задачи.

Если CLI сообщает `approval request failed`, задача не выполнена. Не подменяй её самодельной записью файлов и не меняй глобальные разрешения. Сообщи точную причину. В Electron пользователь сам выбирает provider mode перед отправкой: «Штатные разрешения» либо для Codex «Самостоятельно в рабочей папке» (never + workspace-write). Выбор сбрасывается после отправки и не меняет global config. CLI-эквивалент явного выбора — `--mode workspace`. Не включай этот режим за пользователя для live-проверки без его согласия; sandbox не отключай.

## 3. Создание первого плагина

```sh
npm run plugin -- scaffold my-plugin
```

Команда создаёт `extensions/my-plugin/manifest.ts`, `module.ts`, `extension.ts`. ID — lowercase slug, например `turn-note`. Существующие файлы не перезаписываются. Это исходники внутри checkout FRNESS, не новый npm workspace. Файлы `extensions/**/*.ts` входят в typecheck.

Шаблон уже содержит:

- пакет `local.my-plugin`, версию `0.1.0` и все точные внешние зависимости;
- `Configuration`, `Note` и `Observer` как определения через метасущности;
- `factory.v1` с собственной логикой и ObjectStore;
- keyed слот `children`, принимающий тот же EventObserver: leaf можно заменить поддеревом;
- собственный SQLite child, storeId, namespace, scope и grants;
- запись terminal-события в Note с дедупликацией по точному source ref/revision;
- reload hooks для stateless process state; долговечные Note остаются в SQLite.

Меняй только нужную функциональность. Для другого поведения сначала зафиксируй контракт, затем схему, реализацию и тест. Пример полноценного исходника — `extensions/turn-note`; исходник SDK-шаблона — `tools/plugin-template`.

## 4. Форматы, которые нельзя угадывать

DefinitionRef: `{packageId, packageVersion, digest, name}`. Совместимость номинальная: одинакового имени или JSON shape недостаточно. Digest вычисляет сборщик. Не записывай выдуманные digest и не используй плавающие `latest`.

В исходном manifest:

```ts
const local = (name: string) => ({ local: name });
// meta("Type") — точный ref метасущности Type.
// lookup("std.agent-runtime", "EventObserver") — ref уже собранной зависимости.
// local("Configuration") — ссылка на определение этого пакета.
```

`PackageManifest`: `format: 1`, `packageId`, `version`, `hostAbi: "fractal.host.v1"`, `dependencies`, `definitions`, `exports`, обязательный `reload`.

`Implementation.value`: `contracts`, `configurationType`, `stateType`, `slots`, `entry`, `abi`, `requiredCapabilities`. Слот: `{name, accepts: ContractRef, collection: "single" | "keyed" | "ordered", min, max}`.

Runtime instance: `{instanceId, implementation: DefinitionRef, configuration, stateNamespaceId, scopeId}`. Binding: `{parentInstanceId, slot, childInstanceId, key? , order?}`. Для keyed нужен стабильный key; для ordered — order. Идентичности instances/namespaces уникальны во всём профиле. Циклы, несовместимый контракт, неправильная кардинальность и недостающие grants должны отклоняться до запуска работы.

Весь JSON должен быть сериализуемым: без функций, undefined, классов, getters, NaN, Infinity и циклов. Используй `canonicalJson(value)` для стабильных ключей. Не передавай `canonicalJson` напрямую в `.map`: второй аргумент функции имеет другой смысл; пиши `.map(value => canonicalJson(value))`.

## 5. Экспорт логики и возможности

`factory.v1` реализует:

```ts
factory.create(context) => Promise<{ value: unknown; dispose(): void | Promise<void> }>
```

`context` предоставляет `instance`, `assemblyRevision`, `implementation`, `registry`, `child(slot)`, `children(slot)`, `capability(name)`, `exported(ref, instanceId?)`. Не выбирай зависимости по порядку файлов и не импортируй реализации соседних плагинов вместо slot binding.

Базовый CLI observer реализует:

```ts
observe(input: { session: ObjectRef; event: ObjectRecord }): Promise<void>
```

`input.event` — сохранённый объект std.agent-runtime/Event; `input.event.value` содержит `{session, turn, event}`. Внутренний `event.kind` бывает `session`, `text`, `provider`, `terminal`; terminal содержит `status`, `result`, `errorCode`. Raw provider данные лежат в provider event, не в обязательных полях ядра.

Observer — побочный подписчик: runtime сохраняет свой результат независимо от ошибки observer. Не используй его для обязательного допуска к запуску или обещаний exactly-once внешнего эффекта. Для допуска есть отдельный слот `cli.launch.policy` (0..1); для нескольких observers — `cli.events.observers` (keyed). Не меняй штатный результат ради статистики.

Native capabilities выдаются явными grants: `local.subject`, `native.sqlite`, `data.directory`, `process`; credential/filesystem/repository bindings дополнительно закрепляются профилем и экземпляром. `requiredCapabilities` в manifest не выдаёт права само по себе. Extension — доверенный локальный код Node с правами пользователя, не OS sandbox.

## 6. Свои данные

ObjectRef: `{storeId, namespaceId, objectId, type: TypeRef}`. ObjectRecord: `{object, revision, value}`. Не обращайся к чужим namespace без явного grant; владелец и scope происходят из trusted context, не из JSON пользовательской команды.

Store ABI:

```ts
store.read(context, ref, revision?)
store.commit(context, {
  commitKey, readSet: [], events: [],
  writes: [{kind: "create", object: ref, value}]
})
```

Replace требует `expectedRevision` (CAS). Много связанных записей фиксируй одним CommitBatch. Повтор commitKey с тем же содержимым возвращает прежний receipt; другое содержимое — конфликт. Стабильный ключ вычисляй из источника события, его revision и семантики операции. Время/случайность в повторном payload нарушают идемпотентность.

`registerNamespace(id, ownerInstanceId, scopeId)` — возможность конкретного SQLite service, не метод общего ObjectStore ABI. Шаблон получает service через свой slot и регистрирует собственный namespace. Ни dispose, ни reload не удаляют пользовательские данные.

При изменении схемы создай новый TypeRef/версию. Не меняй type существующего ObjectRef и не заменяй невалидные данные defaults. Для миграции нужны явная операция, сохранение старых версий и CAS переключения ссылки на новый объект. Если это выходит за задачу, остановись на совместимой схеме, а не делай скрытый destructive SQL.

## 7. Подключение и обновление

```sh
npm run plugin -- install extensions/my-plugin/extension.ts /absolute/path/to/workspace
npm run plugin -- status /absolute/path/to/workspace
```

Если ты выполняешь задачу внутри активного FRNESS turn, не вызывай install синхронно: writer lease занят твоим запуском. Запроси подключение после своего завершения:

```sh
npm run plugin -- request extensions/my-plugin/extension.ts /absolute/path/to/workspace
```

После completed turn FRNESS освобождает lease, проверяет candidate и применяет запрос без участия пользователя. Результат обновления сохраняется в `.frness/plugins/last-update.json`; ошибка candidate не меняет active pointer и показывается отдельно от результата агента. Failed/cancelled/unknown turn не активирует pending запрос. Новые файлы создаются агентом, не host; генерация SDK — только стартовая заготовка.

В Electron: «Подключить плагин» → extension.ts; после правок — «Обновить плагины». На время выполнения агента подключение заблокировано. После завершения можно обновить код без перезапуска окна. Нужен новый `version`, если поменялись bytes пакета; сборщик не правит версию автоматически.

Install в отдельном Node-процессе собирает profiles для обоих CLI, проверяет bootstrap, digest, ABI, linker, capabilities и инициализацию native factories, затем атомарно заменяет `.frness/plugins/active.json`. До успешной проверки новые запросы не переключаются. Syntax/schema/contract/factory error оставляет прежний pointer. Пакеты кандидата доверенные: factories при проверке не должны выполнять предметные эффекты.

Следующий selfhost/desktop запрос использует сохранённую compiled сборку, а не изменяемые исходники. Поэтому редактирование файлов само по себе не меняет установленный плагин. Старые сборки сохраняются в `.frness/selfhost/builds`, данные — в `.frness/selfhost/data`. Не удаляй их для «починки» reload. `--extension` у selfhost — явный source override для разового dev-запуска, обход установленного pointer по запросу вызывающего.

Один workspace имеет writer lease `.frness/selfhost/writer.lock`. Одновременный run/install получает WORKSPACE_BUSY. После аварии lease намеренно не отбирается по одному PID/таймауту: сначала проверь, что старого исполнителя нет, и разбери неизвестные эффекты; только затем вручную убери оставшийся lock. Не добавляй автоматический повтор неизвестного действия.

Одна extension.ts — composition root, она может включать несколько пакетов/поддеревьев. Это не «реестр ровно одного плагина». При расширении существующей сборки сохраняй старые packages, instances, bindings и grants.

Минимальная форма root-модуля:

```ts
export default {
  packages: [async (meta, lookup) => ({
    manifest: myManifest(meta, lookup),
    files: { "server.mjs": await buildServerModule(absoluteModulePath) },
    activations: ["activate"],
  })],
  extend({ profile, ref }) {
    // Возвращай новый profile, сохраняя имеющиеся поля.
    // Добавь instances, bindings и grants; refs получай через ref(packageId, name).
    return nextProfile;
  },
} satisfies SelfhostExtension;
```

Package builders идут после базовой сборки и в порядке зависимостей: lookup видит ранее собранные пакеты. Новые SDK/инфраструктурные функции добавляй как команды/экспорты существующего tool; не оставляй одноразовые внешние скрипты вместо воспроизводимого workflow.

## 8. Фрактальное поддерево

Чтобы заменить leaf деревом, внешний Implementation продолжает объявлять прежний ContractRef, но получает свои slots, принимающие контракты детей. В factory `context.children("children")` разрешает только закреплённые bindings. Выполни свою логику и делегируй детям через контракт.

Каждому stateful ребёнку выдели свой instanceId/namespace и storage binding; общий store допустим только при явной изоляции и понятном ownership. Повторный вызов родителя не должен дублировать запись ребёнка: дети тоже дедуплицируют источник. Тестируй не только один экземпляр, но минимум parent → child с сохранением их отдельных данных. Проверенный такой сценарий находится в `tests/atoms/plugin-development.test.ts`.

## 9. Другие виды расширений

Для pure reducer: `initialize(input, config)` и `reduce(state, event, config) -> {state, commands}`. Команды `callChild`, `effect`, `awaitInput`, `complete`, `fail` описаны в specs/fractal-harness/contracts.ts. Reducer не делает I/O; внешнее действие идёт через effect adapter с declared retry/reconcile policy. Неизвестный исход — unknown, не автоматический retry.

Managed execution, LLM и tools существуют отдельными пакетами, но не включены в минимальную CLI сборку. Если они нужны задаче, явно добавь зависимости и сборку; не утверждай, что SelfhostExtension автоматически превращает native CLI в managed reducer.

UI: Electron сейчас показывает вопрос–ответ и инспекцию установленной assembly. Это ещё не C09 slot renderer. Если задача про фрактальные UI-плагины, реализуй отдельно ViewDefinition/ActionDefinition через метасущности, explicit bindings, pinned mount и `react-view.v1`; не объявляй произвольный DOM callback совместимым с этим контрактом. У каждого mount свои localViewState/draft. Unmount не отменяет backend. Вкладки, история, форки и проекты также должны стать плагинами, а не таблицами host.

Hot reload сейчас проверен для idle selfhost-сборки с долговечным состоянием: stage/validate/swap, без рестарта окна и без потери данных. Полная замена системных плагинов во время активного invocation, snapshot migration и UI mount handoff из HOT-RELOAD.md этим не закрыты. Не помечай REQ-11/FH-30 выполненными одним plugin install. Для нового пакета reload hooks обязательны: `capture`, `restore`, `ready`, `dispose`; stateless snapshot — точный NullSnapshot + null, соединения/функции/секреты в JSON запрещены.

## 10. Обязательные проверки

Перед кодом зафиксируй наблюдаемое поведение и отказные сценарии. Для нового плагина проверь:

1. Сборка, точные refs, ABI, конформность и успешное прикрепление к выбранному slot.
2. Реальная работа через selfhost с fake CLI-процессом и запись в свой SQLite.
3. Дубликат события/commit; изменённый payload с прежним ключом; изоляция namespace/scope.
4. Parent → child; недостающий child, лишний key/order, несовместимый контракт и config.
5. Новый version + обновление; сохранение старых данных; неправильная candidate не меняет active pointer; редактирование source без install не меняет установленное исполнение.
6. Отмена, missing executable и неизвестный результат, если плагин управляет запуском/эффектами.

Команды из корня:

```sh
npm run typecheck
npm run lint
npm run spec:check
npm run check:boundaries
npm run test:atom -- tests/atoms/plugin-development.test.ts
npm test
# Только при изменениях Electron, в графической сессии:
npm run test:desktop
```

Для документированных атомов также выполняй соответствующий gate из atomic-gates.json. Не ставь skip/xfail и не подгоняй assertions под ошибочную реализацию. Подними локальный сценарий и дёрни реальный путь, а не только compiler. Fake CLI доказывает интеграцию процесса, но не работу прав/авторизации live-агента.

## 11. Сдача результата

Перед commit: `git status --short`, `git branch --show-current`, `git log --oneline -5`, `gh pr status`; убедись, что это FRNESS и нужная ветка. Добавляй только свои проверенные файлы, без `.frness`, node_modules, credentials и generated builds. Коммит без AI-атрибуции; историю не переписывай. Перед разрешённым push проверь diff и коммиты относительно origin.

В implementation-status.json фиксируй только подтверждённое. Не закрывай весь атом по частичной реализации. В отчёте: конкретное поведение, команда запуска, проверки, commit и оставшиеся ограничения. Если последующий шаг уже разрешён и необходим для результата — выполни его; вопрос «статус?» не отменяет работу.

## 12. Первая задача для агента в окне

Выбрав подходящий режим разрешений, можно отправить:

```text
Прочитай AGENT-GUIDE.md. Создай через SDK плагин result-note: собственная Note,
namespace и SQLite, прикрепление к cli.events.observers и слот children.
Добавь в Note длину terminal result в Unicode code points; не меняй host.
Сохрани возможность заменить leaf поддеревом с тем же контрактом.
Проверь настоящий selfhost с fake CLI, повторную доставку и parent → child.
Для интеграционных тестов используй отдельный временный workspace:
текущий workspace занят этим turn, не запускай в нём второй selfhost/install.
Пройди typecheck/lint и относящиеся к задаче тесты, закоммить только свои файлы.
В конце вызови npm run plugin -- request extensions/result-note/extension.ts
с явным абсолютным путём текущего рабочего workspace третьим аргументом.
FRNESS применит candidate после завершения твоего turn. При блокере сообщи
факт и причину, не утверждай, что плагин подключён до receipt.
```

CLI-команда request принимает source и workspace как отдельные аргументы; если путь содержит пробелы, заключай его в shell quotes. Проверка результата после turn: `plugin status`, `.frness/plugins/last-update.json` и фактическая Note в отдельном store. Успешный ответ агента без этих свидетельств не закрывает self-extension.
