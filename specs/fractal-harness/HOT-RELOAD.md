# Hot reload каждого плагина

REQ-11: каждый пакет плагина допускает замену реализации без перезапуска daemon или web shell. Требование распространяется на пользовательские и системные пакеты: метамодель, storage, lifecycle, execution, API, LLM, tools, memory, UI и технические мосты. Низкоуровневый host ABI — код хоста, не плагин; смена его версии требует новой поставки процесса.

## Семантика версии и исполнения

Hot reload создаёт новую immutable registry generation. Прежняя generation остаётся доступной закреплённым исполнениям, пока они не завершатся. Новые вызовы используют новую assemblyRevision; активные invocation не переписывают code/config/schema refs посреди шага. Это режим pin-and-drain, обязательный для v1.

Таким образом заменяются все плагины без restart, но код уже принятого invocation завершает работу на прежней версии. Автоматический перенос активного invocation на новую реализацию в v1 не обещается. Контрольный checkpoint/migration возможен только отдельной объявленной операцией. Если old generation содержит waiting/input invocation, она остаётся retained; новые команды используют новую generation. Количество retained generations наблюдается, принудительное удаление запрещено.

Reload неизменённого artifact допускается и создаёт новый lifecycle generation с теми же DefinitionRef. Изменённые bytes не допускаются под прежней published packageId/version. Watch mode создаёт отдельный staged artifact с effective prerelease version BASE-dev.REVISION (semver BASE-dev.REVISION без пробела; BASE=1.0.0, например 1.0.0-dev.7), не переписывая рабочий source manifest. Lock закрепляет реальные staged bytes/digest. Обычный release меняет version явно.

## Обязательный контракт

PackageManifest.reload задаёт snapshotType и serverEntry/clientEntry — имена manifest exports либо null для отсутствующей стороны. Для каждого присутствующего runtime entry обязан быть reload export. Reload snapshot — JSON по объявленной схеме, без функций, connections, React elements или credential values. Source snapshotType допускает local ref; resolver обрабатывает это известное поле manifest отдельно от произвольного JSON.

Экспорт реализует ReloadParticipant из contracts.ts:

- capture получает только принадлежащие пакету instance/resource IDs и сохраняет переносимое состояние с его точным TypeRef.
- restore поднимает новую реализацию в закрытой candidate generation, проверяет snapshot и переносит его через явно объявленную чистую migration, если тип изменился.
- ready проверяет зависимости, ABI, ресурсы и способность принимать работу без публикации побочных действий.
- dispose освобождает ресурсы только своей generation. Он не удаляет долговечные данные и не отменяет чужие исполнения.

Stateless пакет явно объявляет snapshot schema null и возвращает ReloadSnapshot с value=null; generic implementation этих hooks предоставляет SDK. Отсутствие hooks не означает безопасный reload. Подготовка и capture/restore не выполняют новые предметные effects. Сохранённые объекты не мигрируют автоматически при смене кода: при необходимости применяется C10 с Head CAS и сохранением старых версий.

## Протокол переключения

1. Принять ReloadRequest через lifecycle operation. Повтор ключа+того же payload возвращает прежний receipt; иной payload — IDEMPOTENCY_CONFLICT.
2. Проверить expectedGenerationId. Подготовить artifacts и candidate registry; пройти digest/source refs/self-validation/linker/conformance. Прежняя generation продолжает обслуживать работу.
3. Зафиксировать readSet конфигураций и membership экземпляров. Capture по generation-owned hooks; restore/ready новой generation в отдельном resource scope.
4. Выполнить короткий технический admission barrier: запретить новые admits для переключаемого root, дождаться начатых registration/transaction critical sections. Предметные callbacks не исполнять под mutex переключения.
5. Одним control commit проверить generation CAS/readSet и сохранить active-generation pointer, new lock/assembly и reload receipt. Обмен in-memory route pointer выполняется внутри того же barrier после durable commit. Все запросы получают только целиком old либо целиком new generation; mixed bindings запрещены.
6. Снять barrier. UI получают ReloadCommitted с новой generation. Old invocations и их completions маршрутизируются по закреплённой generation, а не по текущей.
7. Retire old generation. После refcount=0 дождаться dispose; ошибки cleanup записать, не отменяя уже успешный commit. Cleanup не блокирует другие generations. До commit ошибка откатывает candidate и освобождает только candidate resources, прежний active pointer/данные сохраняются.

Crash после control commit восстанавливает новую active generation по сохранённому lock. Старые незавершённые invocations восстанавливаются по своим locks. Crash до commit восстанавливает прежнюю generation; candidate не публикуется. Retained artifacts нельзя удалять по таймеру при наличии durable refs.

## Storage, runtime и системные мосты

Все generations одного физического store используют одну technical writer lease и admission boundary. Storage reload ждёт завершения admitted транзакций и подключает новую реализацию через стабильный storeId/resource handle. Открытые reads удерживают прежнюю generation до завершения. Ни нового второго writer, ни изменения текущих ObjectRef/namespaceId нет. Базовый storage format v1 сохраняется; изменение schema данных требует явной migration, а непроверенный destructive DDL в prepare запрещён.

Execution generation обслуживает только назначенные ей invocations. Сchedulers и subscriptions generation-scoped; новый scheduler не подбирает old generation invocations. Каждый command/effect имеет один owner generation. Ledger, inbox/outbox и remote keys живут в durable store и не сбрасываются при reload. Late completion сохраняется old owner либо recovery route по тому же invocation lock.

Мета-validator и ABI bridge загружаются повторно в candidate registry с новым scope. Повтор ABI ID в одной generation запрещён; одинаковый ID в разных generations разрешён. Compatible reload использует тот же hostAbi. Добавление разрешённого bridge меняет проверенный candidate BootLock; обычный пакет не получает право регистрации нового ABI. Fixed host interface не переписывается.

Lifecycle reload завершает своё уже принятое invocation в old generation; новый lifecycle handler начинает обслуживать дальнейшие операции после swap. Ownership технического supervisor и publication barrier принадлежит host, а политика и данные reload — lifecycle-плагину. Поэтому reload manager не удаляет собственный stack до формирования receipt.

API reload не разрывает соединения без необходимости: transport handle принадлежит stable resource scope; routes/operation dispatch generation-scoped. Нельзя дважды bind один порт. Клиент может переподключиться и догнать journal с cursor, не повторяя принятую command.

## UI и собственные слоты

На ReloadCommitted mount сохраняет mountId, target ObjectRef/fixedRevision, localViewState и dirty draft. Старый renderer capture завершается, candidate renderer restore/ready проверяет state/props/targetType, затем viewInstanceId/assemblyRevision/definition refs mount атомарно переключаются как данные UI-плагина. Сохранённый объект не копируется.

Дочерние mounts восстанавливаются по стабильным binding identities. Совместимые slots сохраняют local state; удалённый slot получает unavailable state с возможностью сохранить draft, не исчезает молча. Несовместимая state migration или renderer failure оставляет прежнее представление. React-internal ephemeral state может пересоздаваться; пользовательские drafts/выделение/раскладка обязаны находиться в localViewState и переноситься.

Old async callback несёт generation token; после switch он не меняет new UI state. Unsubscribe/dispose old generation выполняется ровно один раз и не затрагивает subscriptions новых mounts. Backend reload может быть успешен при offline клиенте; после reconnect client поднимает нужную compatible generation либо явно показывает incompatibility с сохранёнными данными. Между server и browser не обещается distributed atomic transaction.

## Watch и диагностика

CLI: plugin reload PACKAGE --source DIR; plugin watch PACKAGE --source DIR; plugin reload-status RELOAD_ID. Source watcher смотрит только зарегистрированный root пакета, исключает node_modules/artifacts/cache. Изменения группируются; candidate builds получают монотонный desiredRevision. Поздно завершившийся старый build не может заменить более новый. Watch вызывает тот же reload protocol, не отдельный непроверяемый путь.

Наблюдаемые поля: current generation, candidate state, pinned old invocations, retained resources, validation/migration/cleanup failures. Лимит retained generations предупреждает об удержании ресурсов и может отказать новой admission с RELOAD_LIMIT_EXCEEDED; он не убивает старые задачи. Ошибки snapshot/hook — RELOAD_PREPARE_FAILED, stale generation — REVISION_CONFLICT, ABI несовместимость — UNKNOWN_ABI. Каждый отказ сохраняет active generation и данные.

## Приёмка

[tests/hot-reload.feature](tests/hot-reload.feature) содержит HR-001…HR-012. Runtime, UI, storage, meta и lifecycle варианты обязательны; поддержка reload только обычных feature-плагинов не закрывает REQ-11.
