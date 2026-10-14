# Runtime: нормативный контракт и приёмка

Статус: спецификация для реализации самостоятельного харнеса. Слова MUST и MUST NOT обозначают обязательные условия приёмки. Runtime реализуется стандартным плагином на TypeScript; целевая среда MVP — Node.js 24, один writer-процесс и локальная SQLite. Здесь описаны контракты, а не существующая реализация. Имена и wire-формы DTO задаёт [contracts.ts](contracts.ts), общую семантику — [CONTRACTS.md](CONTRACTS.md); этот документ уточняет execution lifecycle без создания альтернативных DTO.

## 1. Граница host и стандартных плагинов

`Request`, `Invocation`, `Effect`, `Attempt`, `Reservation`, inbox/outbox и их статусы объявляет стандартный runtime-плагин через метамодель. `AgentTask`, кандидат ответа и проверка принадлежат плагину агентского цикла/проверок. Host MUST NOT содержать таблицы предметных сущностей, интерпретировать `Invocation.phase` или знать о сессиях, задачах и моделях.

Host предоставляет загрузчик, registry точных определений, пространства хранения с проверкой capabilities, вызов обработчиков и границу исполнения внешних операций. Runtime читает собственные ObjectRecord через ObjectStore.read и сохраняет объекты/события только через ObjectStore.commit(context, CommitBatch). Прямой доступ runtime к SQLite или дополнительный transaction API не допускаются. Вызовы адаптеров проходят через границу внешних операций. Набор статусов ниже — контракт runtime-плагина, а не закрытая система статусов host.

MVP загружает доверенные плагины в общий процесс. Ограничения SDK — инженерный контракт. Они не являются sandbox: произвольный доверенный код технически способен обратиться к Node API. Изоляция недоверенного кода, несколько writer-процессов и распределённый scheduler не входят в MVP.

## 2. Идентификаторы, версии и неизменяемые записи

Каждый объект получает отдельный стабильный ID внутри ObjectRef. IDs request, invocation, effect, attempt, reservation и event MUST NOT подменять друг друга. Публичный InvocationReceipt возвращает `request` и `invocation` как ObjectRef. Новая попытка того же внешнего действия получает новый `attemptId`, сохраняя `effectId`.

Каждый live invocation привязан к одной immutable assembly через `assemblyRevision`. Assembly фиксирует точные DefinitionRef схем, реализаций, адаптеров, конфигурации, политик и схемы storage. Exact DefinitionRef включает packageId, packageVersion, digest и name. Плавающая ссылка `latest` допускается только до фиксации assembly. После создания invocation её замена запрещена. Одинаковая версия с другим digest также считается несовместимой зависимостью.

Полный запрос внешнего действия после validation сохраняется до первой отправки. Для EffectDefinition неизменяемы adapterInstanceId, adapter, adapterConfiguration, accountRef, operation, input, inputDigest, remoteKey и policy. inputDigest вычисляется по canonical-json-v1 из CONTRACTS C06. Нельзя заново собрать запрос из текущей памяти, времени или настроек при retry. remoteKey всегда строка; для адаптера без native idempotency наличие ключа не даёт разрешения на повтор.

Секреты не записываются в запрос или журнал: сохраняется ссылка на разрешённый credential binding. Фактический credential разрешается на dispatch. Изменение binding на другой внешний account меняет область идемпотентности и MUST NOT происходить скрыто при resume.

## 3. Объекты runtime-плагина

Ниже перечислены canonical DTO и поддерживаемые ими записи. Вспомогательные индексы, checkpoints и inbox/outbox — private typed ObjectRecord runtime-пакета, а не вторые wire-модели известных DTO. Их TypeRef и схемы также фиксируются assembly.

| Тип/запись | Canonical поля и смысл |
|---|---|
| InvocationRequest | `targetInstanceId`, обязательная явно выбранная `assemblyRevision`, `operation: OperationRef`, `input`, обязательный `idempotencyKey`; immutable Request сохраняется с контекстом |
| InvocationSnapshot | `ref`, `phase`, `control`, `waitingReason`, `unresolvedEffectIds`, `result`, `error`; собственное состояние и lineage хранятся отдельными runtime records |
| EffectDefinition | `effectId`, `invocationId`, `adapterInstanceId`, `adapter`, `adapterConfiguration`, `accountRef`, `operation`, `input`, `inputDigest`, `remoteKey`, `policy: RetryPolicy` |
| AttemptRecord | `attemptId`, `effectId`, `runnerEpoch`, `state`, один `reservationId`, `result: VersionedObjectRef` или null |
| BudgetSpec / BudgetSnapshot | `unit`, `limit`, `maxSteps`, `maxDepth`, `maxConcurrentEffects`; проекция `reserved`, `spent`, `limit` |
| ReservationRecord | `reservationId`, `attemptId`, `ancestorBudgetIds`, `unit`, `maxUnits`, `actualUnits`, `status`; единственная reservation, на которую ссылается AttemptRecord |
| Inbox/outbox | Типизированные runtime-записи доставки, причинных связей и consumption; события используют ReducerEvent `eventId`, `type`, `value` |
| EffectResolutionRecord | `effectId`, `result: VersionedObjectRef`, `businessResultDigest`, `deliveredEventId`; уникальный effectId обеспечивает одну логическую публикацию |

Usage и доказательства reconciliation хранятся в отдельных typed records и связываются с AttemptRecord. Они не добавляют неописанные wire-поля в AttemptRecord. Версию записи сообщает ObjectRecord.revision; это opaque строка, не счётчик и не поле InvocationSnapshot.

Export reducer.v1 — ReducerModule: чистый синхронный initialize(input,config) создаёт отдельное per-invocation state; reduce(state,event,config) исполняет переходы. State проверяется по ImplementationDefinition.stateType. Собственное исключение initialize/reduce имеет код REDUCER_EXECUTION_FAILED; значение, не соответствующее output/state schema, — INVALID_OUTPUT. T1 сохраняет новый state и execution.InputReceived {invocation,operation,input} по InputReceivedValue. После restart initialize не повторяется для уже сохранённого invocation. ComponentInstance.stateNamespaceId принадлежит долгоживущим данным компонента, а не отдельному вызову. Два invocations одного instance не разделяют reducer state. Общие данные доступны только через явные repository operations с CAS, без shared JS object.

Локальный repository путь определён в CONTRACTS C07: callChild в std.storage.Repository slot вызывает store.v1 read/commit с доверенным context; async bridge сохраняет ChildCompleted/ChildFailed. Storage commit имеет стабильный технический ключ parentInvocationId+commandId, поэтому crash до child receipt не повторяет мутацию. Replay читает сохранённые child results и не обращается к live repository. Runtime-owned persistence T1–T5 использует ObjectStore напрямую с выданной технической capability; это не разрешает предметным reducers делать I/O.

ReducerCommand.effect содержит adapterInstanceId непосредственного ребёнка, подключённого в слот текущего instance. Runtime разрешает его только по pinned assembly, проверяет ABI effect-adapter.v1, экспорт OperationRef и capabilities и фиксирует adapter ImplementationRef/config/accountRef в EffectDefinition. Произвольный sibling или голый ImplementationRef не являются допустимой целью. Новый credential для прежнего account допустим; смена account/config при resume запрещена.

`unresolvedEffectIds` — обязательная проекция invocation: уникальные IDs собственных и дочерних effects с хотя бы одним `dispatched` или `unknown` attempt. Она может вычисляться из индекса. Если материализуется, изменения и её обновление MUST выполняться атомарно. Это отдельная характеристика от terminal phase.

Inbox и outbox описывают durable сообщения и намерения. Они не означают, что внешняя система участвует в SQLite-транзакции.

## 4. Invocation: состояния и переходы

```text
phase         = queued | active | waiting | succeeded | failed | cancelled
control       = running | paused | cancel_requested
waitingReason = effect | child | input | indeterminate | null
```

Terminal phases: `succeeded`, `failed`, `cancelled`. Terminal phase не меняется после позднего completion, pause, resume или повторного cancel. Команда управления terminal invocation возвращает текущее состояние и не начинает новую работу.

`waitingReason` MUST быть non-null только при `phase=waiting`. Pause не является причиной waiting: это независимый запрет новых dispatch. Invocation может оставаться active или waiting во время паузы.

| Из phase | В phase | Условие |
|---|---|---|
| queued | active | Начато исполнение закреплённой реализации |
| queued | failed | До старта обнаружена доказанная невосстановимая ошибка входа/сборки |
| queued | cancelled | Принят cancel |
| active | waiting | Записана конкретная зависимость и `waitingReason` |
| waiting | active | Зависимость разрешена; переход выполняет reducer |
| active | succeeded | Контракт операции выполнен, результат сохранён, нет собственных незавершённых переходов |
| active или waiting | failed | Доказанная terminal ошибка; обычный timeout внешней записи доказательством не является |
| active или waiting | cancelled | Принят cancel; локальное планирование прекращено |
| terminal | тот же terminal | Идемпотентная повторная доставка/команда, без изменения результата |

Другие переходы отклоняются с `INVALID_TRANSITION`. `queued → succeeded` напрямую запрещён. `unknown` не превращается в `failed` или `succeeded` без новых доказательств; обычное продолжение ставится в `waiting/indeterminate`. При cancel допустимы `phase=cancelled`, `control=cancel_requested` и непустой `unresolvedEffectIds`.

Для queued/active/waiting control допускает `running ↔ paused` и переход из любого из них в `cancel_requested`. Cancel атомарно меняет управляющую запись корня поддерева. Каждый dispatch читает управляющие записи всех предков и включает их revisions в CommitBatch.readSet: это сразу запрещает новые dispatch во всём поддереве. Материализация cancelled у потомков и cleanup неподанных reservations выполняются ограниченными CommitBatch; нельзя превысить лимит 1000 writes ради одной большой cancellation-транзакции. Prepared attempts, которые не стали dispatched, переводятся в failed_known с ошибкой CANCELLED_BEFORE_DISPATCH, evidence локального control commit и actualUnits=0; reservation становится settled. Историческая запись сохраняется, но больше не блокирует fork как prepared. Уже отправленные attempts продолжают учитываться отдельно.

## 5. Attempt: внешний результат и crash windows

```text
prepared → dispatched → completed
                      → failed_known
                      → unknown
prepared → failed_known  // CANCELLED_BEFORE_DISPATCH и доказанный control commit
unknown → completed | failed_known  // только подтверждённый completion/reconciliation
```

| Состояние | Утверждение runtime |
|---|---|
| prepared | Намерение и reservation записаны; вызов транспорта ещё не разрешён |
| dispatched | Разрешение на одну попытку записано; запрос мог покинуть процесс |
| completed | Полный валидный результат этой попытки сохранён |
| failed_known | Итог попытки доказан; сохранено, что известно о внешнем действии и расходе |
| unknown | Достаточных данных об исходе нет; возможно выполненное внешнее действие |

При рестарте все dispatched attempts прежнего `runnerEpoch` переводятся в unknown. Даже падение после commit dispatched, но до первого обращения к транспорту, не позволяет runtime автоматически считать действие невыполненным.

`unknown → dispatched` запрещён. Retry создаёт новый Attempt. Late completion прежнего unknown attempt может разрешить его, если проходит проверку идентичности, схемы и hash. Одинаковый повторный completion — no-op; конфликтующее содержимое — `COMPLETION_CONFLICT`. Первая сохранённая версия не заменяется.

Несколько attempts одного effect могут получить completion, но логический результат effect публикуется вызывающему reducer ровно один раз. Для этого хранится уникальная запись resolution по effectId. Сравнивается business payload по схеме результата; attempt usage и transport metadata не входят в его hash. Совпадающий поздний результат обновляет только evidence/accounting соответствующего attempt. Разный business payload для уже разрешённого effect даёт `COMPLETION_CONFLICT`, сохраняется как диагностическое evidence и не перезаписывает первый результат.

Для `failed_known` отдельно сохраняются доказательства внешнего результата и расхода. HTTP timeout, оборванное соединение и смерть процесса сами по себе не доказывают отсутствие изменения. Адаптер классифицирует их как unknown. Для чтения/LLM может быть доказана неполнота результата без подтверждённого usage: ошибка результата не освобождает неизвестный reservation.

Переход prepared→failed_known разрешён только для локально доказанной отмены до dispatch. Cleanup CommitBatch включает readSet управляющей записи и expectedRevision прежнего prepared attempt, сохраняет CANCELLED_BEFORE_DISPATCH со ссылкой на control commit и урегулирует его reservation с actualUnits=0. Если T3 уже выиграл гонку, этот переход запрещён: выполняется обычное ожидание/unknown/reconciliation без обнуления расхода. Контрольные записи достаточны для доказательства отсутствия dispatch; одного флага cancelled без проверки attempt revision недостаточно.

## 6. Транзакционные границы и доставка

Runtime MUST выполнять переходы через последовательный writer и CommitBatch. Reducer получает immutable plain state/event/config и синхронно возвращает ReducerResult. Он не исполняется как callback внутри SQL-транзакции. Сеть, LLM, ожидание человека, Promise, таймеры, произвольная случайность и чтение live clock внутри reducer запрещены. Runtime вычисляет переход, затем отправляет CommitBatch с readSet всех использованных записей, expectedRevision для replace/tombstone и typed events. Storage атомарно проверяет capabilities, схемы и CAS и записывает revisions вместе с durable journal. Недетерминированные значения поступают через logged effects.

| Cut | Один атомарный CommitBatch | Что разрешено после commit |
|---|---|---|
| T1 — принять команду | После auth/input и initialize/state validation: индекс ключа; Request; queued Invocation; отдельный per-invocation state; execution.InputReceived event | Scheduler может исполнить событие |
| T2 — подготовить действие | Новое состояние; consumed event; EffectDefinition; prepared AttemptRecord; Reservation; OutboxIntent | Dispatch может рассматривать намерение |
| T3 — разрешить отправку | ReadSet ancestor control/phase/budget и reservation; проверка текущих прав; expectedRevision attempt; переход prepared→dispatched; runnerEpoch | Ровно одна попытка обращения к транспорту |
| T4 — получить результат | Immutable completion/usage evidence; attempt transition; новое inbox event; settlement только доказанного usage | Reducer может обработать результат |
| T5 — применить событие | ReadSet источников; состояние reducer; consumedEventId; новые intents/reservations/events | Новые внешние операции после своих T3 |
| TC — cancel | Control/phase корня отменяемого поддерева; событие отмены; по возможности ограниченный cleanup неподанных reservations | Все descendant dispatch блокируются проверкой ancestors; поздние результаты принимаются |

T2 и T5 — одна и та же форма атомарного перехода; раздельные названия показывают первый и последующие шаги. Если процесс упал до commit или storage CommitBatch был отклонён, его state/consumed marker/intents не появляются. Непотреблённое событие после recovery может быть обработано той же закреплённой реализацией. REDUCER_EXECUTION_FAILED и INVALID_OUTPUT обрабатываются иначе: частичных writes нет, runtime отдельным валидным CommitBatch сохраняет failed invocation, соответствующую типизированную ошибку и failed/consumed marker исходного события; прежний state сохраняется. Автоматическое переисполнение poison event запрещено. Если failure commit также не удался, scheduler останавливается до восстановления store. Повторное выполнение после crash MUST NOT порождать второй внешний вызов для уже записанного commandId.

Стабильные уникальные ограничения: ingress idempotency tuple; `(receiverId,eventId)` для consumption; `(invocationId,commandId)` для intents; completion identity attemptId; effectId для логического resolution и его публикации; `(attemptId,unit)` для reservation. Они реализуются typed index records с детерминированными objectId и create/CAS через CommitBatch, а не прямыми SQL-таблицами runtime. Повтор разрешается через сохранённый индекс после повторной проверки прав. Проверка только в памяти недостаточна.

CommitBatch.commitKey scoped по store/principal/scope/ownerInstance согласно CONTRACTS C05. Повтор того же commitKey с тем же canonical payload возвращает прежний receipt до CAS; другой payload даёт IDEMPOTENCY_CONFLICT. Одинаковый eventId с другими байтами даёт EVENT_CONFLICT и откатывает весь batch. Команды complete/fail единственны в ReducerResult.commands; смешивание с другими командами даёт INVALID_COMMAND_BATCH. Complete запрещён при незавершённых child/effect и unresolved effects.

## 7. Идемпотентность и retry

Все публичные InvocationRequest MUST содержать idempotencyKey из 1..128 ASCII символов и явную assemblyRevision, выбранную вызывающей стороной. Runtime не подставляет текущую active revision при ingress или retry. Входная идемпотентность scoped строго по `(principalId, scopeId, targetInstanceId, exact OperationRef, idempotencyKey)`. Body digest по canonical-json-v1 включает operation, targetInstanceId, input и assemblyRevision из InvocationRequest; grant-набор не входит в digest и проверяется при каждом повторе. Совпадающий digest возвращает исходные Request/Invocation ObjectRefs, в том числе после deployment другой active assembly. Другое тело либо явно другая assemblyRevision в том же scope даёт IDEMPOTENCY_CONFLICT без второй операции. Новый желаемый запуск использует новый ключ. Отсутствующая assemblyRevision или отсутствующий/пустой/недопустимый ключ дают INVALID_INPUT до T1.

Внешняя идемпотентность scoped по внешнему account, сервису и операции. EffectDefinition.remoteKey стабилен на effect и отличается для других effects, включая дочерние эффекты с одинаковыми аргументами и effects нового fork. Attempt ID не подставляется вместо remoteKey при retry.

RetryPolicy.strategy принимает read-only, idempotency-key, reconcile или non-retryable. Read-only допускает повтор задекларированной операции без бизнес-изменений, с новой reservation. Неизвестная запись автоматически повторяется только для idempotency-key, если адаптер подтвердил применимость native idempotency, logged time не превысил idempotencyValidUntil и неизменны account/operation/inputDigest. Reconcile запрашивает доказательства отдельной описанной операцией; non-retryable не отправляет повтор. Без допустимого пути invocation остаётся waiting/indeterminate с EXTERNAL_OUTCOME_UNKNOWN. UI не должен выдавать это состояние за доказанную ошибку.

EffectAdapter.execute/reconcile возвращают canonical EffectOutcome: completed, failed_known или unknown. Throw и transport timeout интерпретируются как unknown, если adapter не предоставил доказательства отсутствия действия. Reconcile не повторяет исходную запись: использует уже записанное evidence либо делает зарегистрированный запрос чтения прежнего результата. Отсутствие реализации reconciliation возвращает unknown. actualUnits=null сохраняет reservation даже при известном результате; никакого неявного actualUnits=0. Все вызовы транспорта при reconciliation входят в C и журнал; fixture RT-007 использует уже полученный receipt без дополнительного transport call.

Idempotency retry может доказать бизнес-результат, но не обязательно расход предыдущей попытки. Reservation прежнего unknown Attempt остаётся до отдельного подтверждения usage. В тесте такого retry fake remote предоставляет receipt первой попытки; runtime явно выполняет reconciliation с этим receipt. Нельзя освобождать предыдущий reserve просто из-за успеха следующего attempt.

Retry rules, максимальное число попыток и ожидания — данные закреплённой policy. После доказанной ошибки нельзя бесконечно повторять reducer или adapter. Достижение заданного числа попыток оставляет последний фактический исход; unknown не переименовывается в известную ошибку.

## 8. Бюджет: единицы и атомарный учёт

BudgetSpec.unit — расширяемая строка профиля бюджета. V1 использует одну unit для цепочки scope invocation; при несовпадении unit ребёнка и предка сборка бюджетов отклоняется с INVALID_INPUT. ReducerCommand.effect.maxUnits задаёт ReservationRecord.maxUnits единственной reservation этой попытки. BudgetSpec.limit, maxUnits и подтверждённый actualUnits — неотрицательные safe integers JavaScript. Значения NaN и Infinity отклоняются на JSON-границе с NON_JSON_VALUE; отрицательные числа, дроби и числа вне safe range — с INVALID_INPUT. Для принятой попытки максимальный расход должен быть известен заранее.

Для каждой единицы проверяется каждый ancestor scope:

```text
sum(actualUnits of distinct settled descendant attempts)
  + sum(maxUnits of distinct reserved descendant attempts)
  + newMaxUnits
  <= scope.limit
```

Один Attempt учитывается один раз в каждом scope. Родитель не складывает собственный агрегат с уже включённым агрегатом ребёнка. Делегирование child Invocation не создаёт расхода. Подготовка Reservation и проверка всех ancestor scopes атомарны в одном CommitBatch: недостаток у любого предка даёт BUDGET_EXCEEDED и ноль новых записей.

После подтверждения actualUnits ReservationRecord.status меняется на settled. При maxUnits=60 и actualUnits=40 остаётся spent=40 и reserved=0; значение 100 никогда не становится расходом одной попытки. Unknown reserve сохраняется после pause/cancel/retry. Отсутствие usage не равно нулевому расходу.

Default profile учитывает model-call: для каждой потенциально оплачиваемой попытки LLM maxUnits=1 и actualUnits=1 при подтверждённом вызове; у немодельного инструмента в этой единице maxUnits=0/actualUnits=0. Это ограничение числа model calls, не обещание ограничения денежных затрат или токенов. Другой бюджетный профиль может задать другую unit для всей цепочки. Приёмочные budget-тесты используют отдельный fake profile с test-credit, maxUnits=60 и actualUnits=40; эти значения не меняют default profile.

BudgetSpec.maxSteps ограничивает число committed reducer-переходов по уникальным входным событиям; повторная доставка уже потреблённого события не добавляет шаг. maxDepth ограничивает runtime lineage (корень имеет depth=0), а не глубину UI/assembly. maxConcurrentEffects ограничивает число физических dispatched/unknown attempts в scope и потомках; prepared не занимает concurrency slot. Проверка этих лимитов атомарна на соответствующем переходе и возвращает BUDGET_EXCEEDED до запрещённой работы. Unknown может продолжать занимать concurrency slot даже после cancel; новый retry требует отдельного свободного slot. Replay использует отдельные scratch-счётчики и не расходует live budget.

Если адаптер сообщил некорректный actualUnits или actualUnits > maxUnits, runtime сохраняет исходное evidence, возвращает INVALID_USAGE, не помечает accounting как settled, не делает скрытого округления/обрезки и блокирует дальнейшие dispatch в затронутом scope до устранения нарушения. Уже совершённое внешнее действие сохраняется в истории. Жёсткая гарантия бюджета относится к адаптерам, соблюдающим заявленную верхнюю границу.

## 9. Pause, cancel и гонки

Порядок T3 и control transaction определяет исход. Если control commit выполнен первым, новая отправка запрещена. Если T3 выполнен первым, одна авторизованная попытка может дойти до внешнего сервиса даже после принятого cancel/pause.

Pause запрещает новые отправки в поддереве, но не мешает T4 и сохранению уже поступающих результатов. Runtime может обработать чистый reducer-переход без нового dispatch; следующий подготовленный effect ждёт resume. Resume не заменяет версии assembly и повторно проверяет текущие права/лимиты перед T3.

Cancel завершает локальное планирование и оставляет у корня `phase=cancelled`, `control=cancel_requested`. Материализация потомков следует правилам раздела 4 и не разрешает им новые dispatch. Late completion может очистить unresolved effects и урегулировать budget, но не меняет cancelled на succeeded. Представление cancellation обязано показывать оставшиеся внешние неопределённости. Для них возможна сверка даже после terminal invocation.

## 10. Replay, resume, fork

| Режим | Идентичность и данные | Внешние вызовы |
|---|---|---|
| replay | Отдельное scratch storage; точные события, схемы и реализации записанного запуска | Запрещены; adapter boundary выдаёт только сохранённые ответы |
| resume | Прежний invocation и assembly; непотреблённые inbox events и прежние effects | Только ещё не отправленные или явно допустимые retry attempts |
| fork | Новый invocation lineage от экспортированного стабильного checkpoint; новые будущие effect IDs и keys | По новой явно выбранной immutable assembly |

Replay сравнивает последовательность запросов, inputDigest, точную OperationRef и commandId с журналом. Несовпадение — REPLAY_DIVERGENCE. Нельзя подставлять «следующий похожий ответ», пропускать запрос или незаметно идти в сеть. Replay не пишет в live storage, включая память, артефакты и bookkeeping исходного запуска.

Resume при отсутствии закреплённой зависимости или несовпадении hash возвращает `PINNED_DEPENDENCY_MISSING` до внешнего вызова. Установка новой реализации не мигрирует активные invocations. Миграция/смена реализации — отдельное явно поддерживаемое действие.

MVP допускает fork только через ForkPlan из CONTRACTS C10: плагины экспортировали согласованное состояние и политики clone/reference/reset/reject, нет активных children, prepared/dispatched/unknown attempts, непотреблённых событий и незавершённых migrations. Иначе CHECKPOINT_NOT_FORKABLE. executeFork проверяет readSet и создаёт целевой граф одной CommitBatch; изменившийся источник даёт REVISION_CONFLICT и ноль target writes. plan/executeFork не имеют внешних effects. Исторические immutable артефакты можно разделять ссылками; новые локальные записи имеют собственные namespaces/IDs. Изоляция внешней изменяемой среды — последующая отдельно разрешённая операция. Новое действие в уже созданной ветке не является частью executeFork.

Cancel-before-dispatch становится forkable после завершения ограниченного cleanup: все такие attempts уже failed_known/CANCELLED_BEFORE_DISPATCH, reservations settled с actualUnits=0, потомки terminal, служебные события обработаны. До завершения cleanup строгая проверка prepared продолжает отклонять fork. Клонирование исторической записи отменённого attempt не превращает её обратно в prepared и не повторяет его внешнее действие.

## 11. Проверенность результата и streaming

Invocation.succeeded означает исполнение контракта конкретной операции. Успешно выполненный verifier может вернуть reject. Host и runtime MUST NOT самостоятельно объявлять задачу решённой на основании окончания LLM-вызова.

Плагин AgentLoop хранит Candidate, Verification и AcceptedResult. Verification содержит candidateDigest, точные версии проверок, evidence и один из результатов accept/revise/reject/inconclusive. Принятие задачи возможно только для текущего candidateDigest после всех обязательных accept. Изменение кандидата требует новой проверки. Reject и inconclusive дают разные причины: VERIFICATION_REJECTED и VERIFICATION_INCONCLUSIVE; они не создают AcceptedResult.

Streaming chunks имеют явный provisional статус. Финальный результат появляется только после нормального протокольного завершения, допустимого finish reason, сборки сообщения и проверки его схемы. До этого tool calls не отправляются, принятая память не записывается, проверенный ответ не публикуется. Обрыв и недопустимое length завершение дают INCOMPLETE_RESPONSE; невалидный final payload — INVALID_OUTPUT. Partial chunks сохраняются для диагностики и отображения как incomplete. Неизвестный usage по-прежнему держит reservation.

При нормальном завершении финального текста допускается обычная проверка результата. Если финальное сообщение содержит tool call, он становится новым effect только после validation всего сообщения, в отдельной транзакции подготовки и с собственным reservation.

## 12. Errors: стабильный словарь runtime-пакета

| Код | Условие |
|---|---|
| INVALID_INPUT | Вход не прошёл закреплённую схему; недопустимые исходные budget числа или ключ ingress |
| INVALID_OUTPUT | Финальный structured payload не прошёл закреплённую схему результата |
| REDUCER_EXECUTION_FAILED | Собственное исключение initialize/reduce; отдельная failure/consumed запись, без автоматического retry poison event |
| CANCELLED_BEFORE_DISPATCH | Prepared attempt отменён до T3; local control commit доказывает отсутствие отправки, actualUnits=0 |
| NON_JSON_VALUE | Значение не представимо разрешённым JSON, включая NaN/Infinity |
| INVALID_COMMAND_BATCH | complete/fail смешан с другими командами либо complete запрещён незавершённой работой |
| REVISION_CONFLICT | ReadSet/expectedRevision устарел; весь CommitBatch отклонён |
| EVENT_CONFLICT | EventId повторён с другими байтами; весь CommitBatch отклонён |
| IDEMPOTENCY_CONFLICT | Один входной ключ использован с другим телом |
| COMPLETION_CONFLICT | Attempt получил несовместимый второй финальный результат |
| BUDGET_EXCEEDED | Новую reservation нельзя целиком разместить у всех предков |
| PINNED_DEPENDENCY_MISSING | Закреплённая схема/реализация отсутствует либо её hash не совпал |
| CHECKPOINT_NOT_FORKABLE | Нет согласованного стабильного checkpoint для fork |
| WRITER_ALREADY_RUNNING | Эксклюзивный writer уже владеет локальным хранилищем |
| INVALID_TRANSITION | Недопустимый переход state machine |
| EXTERNAL_OUTCOME_UNKNOWN | Причина ожидания; не доказанная terminal ошибка внешнего действия |
| REPLAY_DIVERGENCE | Запрос replay не соответствует следующему записанному запросу |
| INCOMPLETE_RESPONSE | Stream не завершён нормально либо завершён с недопустимым finish reason |
| INVALID_USAGE | Usage adapter нарушает числовой контракт или верхнюю границу |
| VERIFICATION_REJECTED | Обязательная проверка отвергла текущий кандидат |
| VERIFICATION_INCONCLUSIVE | Обязательная проверка не располагает достаточными свидетельствами |

Эти коды принадлежат плагинам и доступны через опубликованные типы ошибок. Host transport errors оборачиваются в них только логикой соответствующего плагина.

## 13. Тестовое окружение и fault injection

Исполняемая спецификация — [tests/runtime.feature](tests/runtime.feature). Это приёмочные сценарии для будущей реализации; наличие файла не означает, что runtime уже реализован или сценарии проходят.

Fixture `RuntimeHarness` создаёт временный каталог, файловую SQLite, закреплённую assembly, writer в дочернем процессе Node.js 24 и независимый fake remote. Во всех сценариях `C` — число фактических входов в fake adapter transport, а `S` — число committed business mutations fake remote. После Background счётчики равны нулю. Все реальные вызовы в Given/When/Then, включая restart, учитываются; прямое заполнение fixture данными без вызова транспорта счётчик не увеличивает. Явный `resetCounters` не меняет receipts и данные remote. Бюджеты остаются постоянными при restart.

Fake remote MUST находиться вне убиваемого writer-процесса, вести durable ledger и предоставлять тестовому драйверу read-only счётчики, payload hashes и receipts. Для неидемпотентной записи каждый принятый POST увеличивает S. В режиме native idempotency первый key+payload создаёт mutation и receipt, повтор возвращает прежний бизнес-результат без нового S. Конфликт key+payload отвергается. Receipt содержит фактический результат первой попытки и подтверждённый usage; повторная transport-попытка имеет отдельный usage. Expiry контролируется записанным тестовым временем.

Fake plugins:

- `echo`: input содержит text:string; initialize возвращает {text: input.text, count: 0}; тестовое событие Increment увеличивает только count данного invocation; операция завершения возвращает text. У state и input закрытые схемы; внешних эффектов нет. RT-001 сравнивает сохранённый baseline второго invocation до и после Increment первого.
- `write`: использует неидемпотентный fake remote, test-credit max=1/actual=1; в model-call profile max=0/actual=0.
- `write-idempotent`: тот же сервис с native key и TTL=60 записанных секунд; первый и повторный requests cost=1 каждый.
- `credit-write`: объявляет `test-credit` max=60, actual=40; эти значения допустимы только в соответствующих fixture.
- `model`: stream fixture, model-call max=1 либо test-credit max=1; подтверждённый вызов actual=1, неизвестный usage не освобождает reserve.
- `verifier`: отдельный fake модельный adapter, возвращает заданный accept/reject/inconclusive и candidateDigest, cost=1 в выбранной unit profile.
- `reducer-commit-fault`: детерминированно вычисляет новое состояние и intent; тестовый host останавливает writer через fault hook до commit. После отключения hook повторно доставляется то же событие в ту же закреплённую реализацию, без изменения входа reducer.
- `reducer-throws`: сама закреплённая функция бросает исключение. Runtime сохраняет failed без частичных writes и не переисполняет её автоматически.

Обычные write/budget fixtures используют test-credit profile с limit=100; model/stream fixtures — model-call profile с limit=10. Если сценарий явно задаёт limit, используется он. Unit одинакова у всех scopes конкретной fixture. maxSteps=1000, maxDepth=32 и maxConcurrentEffects=10, если сценарий не переопределяет ограничения. Для неизвестного idempotent retry нужны два concurrency slots. Каждый публичный fixture invoke подаёт валидный уникальный idempotencyKey, кроме специальных тестов отсутствующего/повторного ключа.

Fault hooks MUST быть доступны тестовому драйверу в следующих точках: после T2 commit; после T3 commit до транспорта; после remote mutation до доставки ответа; после T4 commit до reducer; после вычисления T5 записей до commit. Драйвер ждёт явного сигнала hook и принудительно завершает writer. Sleep не доказывает достижение нужного cut. После рестарта проверяются БД, remote ledger, события, reservations и число внешних вызовов.

Writer-lock fixture запускает второй процесс на том же storage. Он MUST получить `WRITER_ALREADY_RUNNING` до загрузки активных задач и не перехватывать их. Lock освобождается при смерти владельца; stale PID-файл сам по себе не является доказательством живого владельца. Конкретный механизм эксклюзивного владения фиксируется в реализации и проверяется RT-023.

## 14. Gate реализации

Runtime не принимается, пока все RT-001…RT-025 и варианты Scenario Outline не проходят на файловой SQLite с реальными перезапусками процессов. Дополнительно gate проверяет: ноль production-вызовов; отсутствие сети из reducers; immutable assembly каждого live invocation; отсутствие незарегистрированных прямых external calls в стандартных плагинах; отсутствие pending reservations, ошибочно освобождённых после unknown/cancel; отсутствие событий принятия для неполных или непроверенных результатов.

Не заменять эти проверки тестами, которые лишь сравнивают названия enum или повторяют реализацию метода. Assertion должен проверять наблюдаемое состояние, persisted records и независимый remote ledger.
