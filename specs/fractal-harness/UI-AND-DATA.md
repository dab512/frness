# UI и данные: нормативная спецификация v1

Статус: проект контрактов для реализации. Это спецификация, а не описание уже работающего продукта. Приёмочные сценарии находятся в [tests/ui.feature](tests/ui.feature); их необходимо реализовать как исполняемые contract/integration/e2e tests. Наличие Gherkin-файла само по себе не означает прохождения проверок.

Единственный источник имён и форм DTO — [contracts.ts](contracts.ts); общая нормативная семантика — [CONTRACTS.md](CONTRACTS.md). Этот документ дополняет их правилами UI и доменных плагинов. Дубли интерфейсов не вводятся. Если необходимое поле отсутствует в wire DTO, оно принадлежит типизированному `input` конкретной plugin operation либо локальному view state, а не добавляется исполнителем в общий API.

## 1. Граница ядра

Сессия, вкладка, проект, история, форк, вопрос и ответ определяются пакетами плагинов через метамодель. Ядро не содержит таблиц `sessions`, маршрутов `/projects`, специальных `sessionId` в execution context или переключателей по доменному типу. Начальная сборка использует только плагин взаимодействия «вопрос → ответ» и его зависимости.

Плагины представления, доменной логики и хранения имеют независимые реализации. UI обращается к операциям через общий Commands API; CLI и автоматизация используют тот же API. В v1 установленные плагины считаются доверенным кодом. Проверка capabilities в API не является sandbox и не защищает от произвольного кода установленного плагина, обходящего SDK.

Scope является непрозрачным техническим идентификатором. Root scope не имеет встроенной семантики проекта/сессии. Определение доменной области, её название и связи принадлежат плагину.

## 2. Идентификаторы и ссылки

Используются `DefinitionRef`, `ContractRef`, `ObjectRef`, `VersionedObjectRef`, `ComponentInstance` и `Binding` из contracts.ts. `ObjectRef.type` содержит точный TypeRef, а историческая ссылка дополнительно фиксирует revision.

`DefinitionRef` сравнивается по всем четырём полям. В v1 нет структурной совместимости, диапазонов SemVer, совпадения только по имени или автоматического перехода на последнюю версию. `ContractRef` должен совпасть точно. Конвертацию реализует явно подключённый адаптер.

| Идентификатор | Назначение | Правило стабильности |
|---|---|---|
| `instanceId` | Экземпляр плагина в сборке | Стабилен после сохранения сборки и перезапуска |
| `entityId` | Идентификатор доменного объекта плагина | Это `ObjectRef.objectId`; отдельный дублирующий столбец не нужен |
| `mountId` | Одно открытое представление объекта | Новый для второго открытия; не задаёт идентичность данных |
| `scopeId` | Область исполнения и выдачи capabilities | Непрозрачен для ядра и хранилища |
| `namespaceId` | Пространство данных | Зарегистрировано для пары `(ownerInstanceId, scopeId)` |

Реестр namespace хранит `namespaceId`, `ownerInstanceId`, `scopeId`, `storeId`. Клиент не может создать namespace произвольным склеиванием строк. Закрытие/создание mount не создаёт новый namespace и не переносит данные. Два экземпляра одного плагина в одном scope имеют разные namespaces; один экземпляр в двух scopes также имеет разные namespaces.

Scope и owner берутся из доверенного execution context. Переданный клиентом `ObjectRef` является адресом, а не разрешением на доступ. Проверка capabilities выполняется до чтения данных/проверки существования объекта и до отправки подписок. Отказ: `CAPABILITY_DENIED`, без value, revision и признака существования чужого объекта.

## 3. Типы, хранение и ревизии

Плагин объявляет `TypeDefinition`, `ContractDefinition`, `ImplementationDefinition`, операции, views и миграции через общую метамодель. Контракты экспортирует ImplementationDefinition, а не TypeDefinition. `ObjectRecord` содержит object, revision и value; отдельного `schemaVersion` нет: версия схемы закреплена в object.type.

Используется только `ObjectStore.read(context, ref, revision?)` и `ObjectStore.commit(context, batch)` из contracts.ts. `CommitBatch` содержит commitKey, readSet, writes и events. Создание/замена/tombstone являются вариантами `RecordWrite`, а не отдельными публичными методами Store. Запросы списка, UI subscriptions и бизнес-редактирование предоставляются операциями соответствующих плагинов поверх этого контракта.

`replace` внутри RecordWrite сохраняет исходный exact TypeRef. Миграция — отдельная операция с pure implementation и source readSet CAS. Она создаёт новый typed record/snapshot, через CAS обновляет plugin-owned Head на актуальную версию и сохраняет исторические записи. Head имеет собственный стабильный тип; это объект плагина, а не скрытая сущность ядра. Новый код получает новый snapshot/namespace согласно C10. UI mount, явно закреплённый на старой версии, не перенаправляется автоматически.

Ревизия — непрозрачная строка, допускающая только сравнение на равенство. Пустой `expectedRevision` у обновления — `INVALID_INPUT`. Нет last-write-wins и неявного merge. `REVISION_CONFLICT` содержит актуальную доступную caller запись; чужие записи не раскрываются.

В v1 все долговечные stores работают поверх одного SQLite database и одного transaction coordinator. Изменение записи, её неизменяемая версия, event/outbox и завершение внутренней команды фиксируются одной транзакцией. При rollback ни одной из этих записей не остаётся. После crash/restart опубликованное состояние не теряет соответствующее событие.

Все участники одного CommitBatch обязаны обслуживаться общим SQLite transaction coordinator. Это проверяется при связывании durable-сборки; дополнительные поля transactionDomainId/atomicBatch в ObjectStore не вводятся. Внешний store не объявляет атомарность с локальной SQLite. Отсутствие требуемой transactional dependency даёт `DEPENDENCY_UNAVAILABLE` до первой записи. Распределённые транзакции в v1 не реализуются. Действуют пределы C01: максимум 1000 writes и 10 MiB на batch, 1 MiB на объект; превышение — `PAYLOAD_TOO_LARGE`, без разбиения атомарного fork на частичные commits.

Исторические версии неизменяемы. Чтение отсутствующей версии возвращает `SNAPSHOT_UNAVAILABLE`, без подстановки текущей версии. Плагин истории удерживает version references; purge учитывает эти ссылки.

## 4. Общий Commands API

Используются `InvocationRequest` и `InvocationReceipt` из contracts.ts: запрос адресован targetInstanceId и обязательно закрепляет assemblyRevision, operation содержит exact contract и имя operation, input валидируется по объявленному TypeRef, idempotencyKey обязателен для любого публичного invoke. Receipt содержит обе ссылки request и invocation. ObjectRef целевого доменного объекта и expectedRevision, когда нужны операции, передаются внутри её типизированного input. Верхнеуровневых target/expectedRevision нет.

UI берёт assemblyRevision из ViewMount, CLI — из явно выбранной сборки. При retry клиент сохраняет всю исходную InvocationRequest, включая assemblyRevision и key; сервер не подставляет latest. Поэтому повтор после обновления сборки возвращает прежний receipt. Смена assemblyRevision с тем же key даёт `IDEMPOTENCY_CONFLICT`; новая пользовательская команда может выбрать новую сборку, но получает новый key.

Семантика Invocation определяется execution-пакетом. UI, CLI и API не содержат собственных обработчиков доменной операции. Контекст полномочий не принимается из input. Transport возвращает HTTP 202/receipt; failure после принятия отражается в состоянии invocation, а не задним числом меняет HTTP receipt.

Дедупликация следует C06: `(principalId, scopeId, targetInstanceId, operation exact ref, idempotencyKey)`; canonical body hash включает operation, target, input и pinned assemblyRevision. Права проверяются на каждом повторе до поиска результата. Точный повтор возвращает те же request/invocation и результат, в том числе после конфликта доменной операции. Повтор ключа с другим body — `IDEMPOTENCY_CONFLICT`. Для исправленного запроса после CAS failure используется новый ключ. Идемпотентность CommitBatch — отдельный нижний уровень C05, который проверяется до CAS.

ActionDefinition ссылается на тот же OperationRef; его inputType обязан точно совпадать с input операции. UI может заранее скрыть/заблокировать кнопку, но invoke повторно проверяет все условия на сервере.

## 5. Представления, слоты и локальное состояние

Используются `ViewDefinition`, `ViewMount` и `ActionDefinition` из contracts.ts. ViewDefinition задаёт exact targetType, propsType и implementation. Единственный владелец slots — ImplementationDefinition; ViewDefinition не дублирует их. Inline SlotDefinition остаются данными метамодели. ViewMount закрепляет viewInstanceId и assemblyRevision вместе с view, target, fixedRevision и props. При fixedRevision=null mount показывает текущие данные, при конкретной revision остаётся на историческом снимке.

Renderer получает mount, targetSnapshot, props и context по клиентскому ABI. `context.renderSlot({slot,key?,order?,props})` разрешает только pinned bindings данного viewInstanceId в mount.assemblyRevision. Обновление текущей сборки не меняет уже закреплённые bindings. Дочернее представление наследует target; explicit target передаётся только в типизированных props согласно схеме child view. Произвольный обход к sibling или global latest запрещён. Неизвестный slot — `UNKNOWN_SLOT`; неверный targetType/props отклоняется до вызова child renderer.

Child mountId детерминирован от parent mountId и identity выбранной binding. Повторный render одного parent сохраняет child local state; два parent mounts одного viewInstanceId получают разные child mountId и независимое local state. Хранилище target при этом остаётся в namespace владельца instance+scope, никогда не в namespace mount.

Owning bindings образуют дерево в составе одного root, лес между независимыми сборками. Owned child имеет одного владельца. Ссылки данных/ресурсов образуют отдельный граф, включая циклы; они не добавляют instance второго владельца. UI не раскрывает reference рекурсивно автоматически: показывает ссылку и раскрывает её только отдельным действием, с path-based cycle marker.

Для keyed-slot обязательны уникальные непустые key и отсутствие order; для ordered-slot — order=0..n-1 без дыр и отсутствие key. Single допускает максимум одного ребёнка без key/order. min/max определяют кардинальность. Ошибки: `SLOT_CARDINALITY`, `CONTRACT_MISMATCH`, `OWNERSHIP_CYCLE`, `MULTIPLE_OWNERS`, `DUPLICATE_SLOT_KEY`, `DUPLICATE_SLOT_ORDER`. Вся сборка проверяется до активации; невалидная сборка не применяется частично.

Плагин может объявить новый слот. Другой независимо установленный плагин подключается, экспортируя точный требуемый контракт. Для этого нельзя добавлять в host switch по имени плагина или новый route/component import.

Локальное view state содержит раскладку, раскрытые секции и черновик формы; оно отделено от authoritative record. Плагин вкладок может сохранять его своим типом, но операция unmount не меняет запись target и не отменяет её исполнения. invoke/observe/localViewState доступны через capability context клиентского ABI, без добавления альтернативного wire ViewContext.

Renderer выбирается явно сохранённой binding. Если binding отсутствует/пакет отключён/targetType не совпадает, стандартный inspector показывает `VIEW_UNAVAILABLE` и доступные caller поля. Inspector использует redacted projection, а не raw storage JSON: значения полей x-sensitive отсутствуют и в его payload. Плагин может исключить поле полностью либо передать фиксированную маску без исходного значения; credential material не хранится как обычное поле. Рендерер неизвестной версии не вызывается. Никакого выбора по времени загрузки пакета.

## 6. Жизненный цикл

| Операция | Обязательное поведение |
|---|---|
| Unmount | Удалить только представление; отписать его listeners; не посылать cancel |
| Disable | Блокировать новые вызовы экземпляра (`PLUGIN_DISABLED`); сохранить активным вызовам pinned package и bindings |
| Uninstall | Убрать пакет из доступных новых сборок; не удалять definitions, данные, версии, историю и pinned code активных вызовов |
| Reinstall | Вернуть доступ к сохранённым данным при совместимой точной версии; новую версию применить через миграцию |
| Purge | Отдельная явная операция; проверить active invocations и durable references; при наличии ссылок `LIVE_REFERENCES` без частичного удаления |

Плагин не получает purge своих данных автоматически при uninstall. Закрытие вкладки/удаление reference из проекта не является purge или cancel. Пакет с активными вызовами нельзя физически удалить: uninstall отмечает retired, освобождение pinned code возможно после terminal состояния и исчезновения ссылок.

## 7. История и форки

История хранит `VersionedObjectRef`/immutable snapshots и provenance. Простая ссылка на latest не является исторической записью. При удалении доступного снимка отображается `SNAPSHOT_UNAVAILABLE`, без замены на актуальные данные.

Fork — операция самостоятельного плагина; ядро не знает веток сессий. Для поддерживаемого типа регистрируется implementation точного Forkable contract. В v1 допустимы terminal или quiescent состояния. Quiescent означает checkpoint, отсутствие незавершённых child calls, prepared/dispatched/unknown effects, migrations и новых разрешённых команд на запись; resume конкурирует с fork через тот же readSet CAS guard. Нарушение этих условий — `CHECKPOINT_NOT_FORKABLE`.

Плагин предоставляет операции planFork и executeFork через общий invoke. Формат сохранённого ForkPlan задан только в contracts.ts: planId, source, readSet, targetScopeId, mappings и planDigest. План заранее выделяет target ObjectRef; execution возвращает ссылки созданного результата через свой output TypeRef. Никакого второго DTO с checkpointRevision/operations/transactionDomainId нет. Нужные checkpoint/lifecycle guards являются ссылками readSet.

Политика обязательна для каждой ссылочной связи обхода, включая reference. Нет defaults по имени поля или типу объекта. `clone` создаёт новый ID из закреплённого снимка; `reference` сохраняет ссылку; `reset` использует declared initial-state factory без внешних эффектов; `reject` блокирует весь план (`FORK_UNSUPPORTED`). Для owned-link `reference` запрещён: иначе существующий child получил бы второго владельца. Можно clone/reset/reject либо отдельно изменить модель связи до планирования.

Ссылки внутри клонируемого поддерева переназначаются по mappings на новые ID. Повторное посещение reference не запускает рекурсивное копирование без его политики. При reference данные не копируются; mappings содержит policy=reference и target, равный исходному ObjectRef. При reject target=null и план непригоден к выполнению. Для clone/reset target — заранее выделенный новый ObjectRef. В v1 повторные ссылки на один source должны задавать одинаковые policy/target; в mappings сохраняется одна запись. Разные политики для одного source отклоняются `FORK_UNSUPPORTED`: wire ForkPlan не содержит path для их однозначного различения. Расширять DTO скрытым порядком обхода нельзя.

План immutable. В readSet входят источники копирования, owner records, snapshot references и lifecycle guards. planFork читает их согласованно и фиксирует revisions. executeFork сначала проверяет idempotency, затем readSet CAS/quiescence и одним CommitBatch создаёт root, children, provenance и события. Максимум 1000 writes на весь batch с учётом служебных записей, максимум 10 MiB. Изменение любого источника после плана, даже если исторический snapshot доступен, — `REVISION_CONFLICT` и ноль target writes. Устаревший источник не обходится чтением старой revision: требуется новый план. Отсутствующий snapshot — `SNAPSHOT_UNAVAILABLE`; неподдерживаемый тип/отсутствующая policy — `FORK_UNSUPPORTED`.

planFork/executeFork не вызывают LLM, инструменты и произвольные effectful handlers. Счётчик внешних эффектов до/после fork одинаков. Ссылка на ранее созданный внешний объект не воспроизводит его создание. Копирование файловой среды/внешних stores и форки активных запусков отложены до отдельной спецификации. Target scope не получает дополнительных grants.

Результат и idempotency key сохраняются в той же транзакции. Повтор после потерянного ответа возвращает тот же root и mapping. Crash до commit оставляет ноль fork-объектов; crash после commit не создаёт второй fork при retry.

## 8. Миграции, черновики и подписки

Используется MigrationPlan из contracts.ts: source и head закрепляют ревизии, destination содержит новый ObjectRef, implementation — точную pure реализацию, planDigest фиксирует план. Миграция читает source/head, запускает преобразование, валидирует destination.type и одним CommitBatch создаёт новый typed record и переключает Head через expectedRevision. Source revision входит в readSet. Ошибка create или Head CAS откатывает обе записи. Невалидный результат — `INVALID_OUTPUT`; оригинальная запись и event count неизменны. CAS-конфликт — `REVISION_CONFLICT`; автоматического повторного применения к новому содержимому нет. Старый record не меняет type; generic replace с другим type запрещён C05.

Черновик содержит base ObjectRef/revision и ревизию доменной ссылки на текущий record, если редактируется current mode. Новое серверное событие не затирает dirty draft. После миграции старый draft помечается conflict, сохраняется локально для экспорта/отмены. Submit через текущую доменную операцию проверяет источник и active-record guard; старый draft получает `REVISION_CONFLICT` и не откатывает ссылку или схему. Historical mounts сохраняют старый ObjectRef. В v1 автоматического merge/переноса draft нет.

Используются SubscriptionSnapshot и SubscriptionEvent из contracts.ts; snapshot/cursor читаются из одной транзакционной границы. Event содержит eventId, cursor, previousCursor и value. ObjectRef/revision/change могут находиться в типизированном value, не добавляются в envelope. События упорядочены; eventId дедуплицируется; previousCursor обязан совпадать с последним применённым cursor. Курсор непрозрачный и привязан к namespace/scope: чужой cursor не даёт доступ.

При reconnect сервер продолжает после cursor. При gap клиент останавливает применение и запрашивает catch-up. Если cursor истёк, возвращается `CURSOR_EXPIRED`; клиент получает новый согласованный snapshot/cursor. События после snapshot cursor дочитываются из durable log; late snapshot не откатывает уже применённые live events. Dirty drafts остаются, но их baseRevision перепроверяется. Противоречащий дубликат eventId — `EVENT_CONFLICT`; нельзя сравнивать непрозрачные revision как числа.

## 9. Матрица приёмки

| Контракт | Обязательные сценарии |
|---|---|
| Stable IDs, namespace, несколько mounts | UI-001, UI-024 |
| CAS и независимые drafts | UI-002, UI-016, UI-018 |
| UI lifecycle, disable/uninstall/purge | UI-003, UI-004 |
| Fallback, version compatibility | UI-005 |
| Плагины добавляют новые слоты, exact matching, own/ref | UI-006, UI-007 |
| Единые команды, idempotency, capabilities | UI-008, UI-009 |
| Исторические версии | UI-010 |
| Fork policy, guards, quiescence, atomicity | UI-011–UI-015, UI-021, UI-023 |
| Миграции и ошибки | UI-016–UI-018 |
| Streaming и durable event publication | UI-019, UI-020 |
| Вертикальный независимый extension | UI-022 |

Для реализации сначала нужны store/commands/definitions fixtures и contract tests; затем renderer/два mounts; затем подписки; затем history и fork. UI-тесты не должны заменять проверки транзакций. Fork crash tests выполняются с реальным SQLite и остановкой процесса на именованном failpoint; fake throw вне транзакции недостаточен.

### Правила fixture adapter

Алиасы в Gherkin раскрываются в точные DefinitionRef/ObjectRef. Выражение digestOf(package@version) в fixture table означает фактический digest fixture-артефакта по C02; его нельзя послать в wire API как строковый placeholder. Это читаемые имена тестовых объектов, не production API. Fixture присваивает следующие свободные идентификаторы из заданной сценарием последовательности; после rollback зарезервированные ID не публикуются. Проверки уникальности production ID выполняются отдельным conformance suite; тесты не требуют последовательных ID в продукте.

Объекты `root-1`, `child-1`, `draft-1`, `ticket-1` создаются до сброса счётчиков соответствующего сценария. Для fork fixture стандартный root хранит JSON ссылок, child — `{text:"copied"}`, draft — `{text:"discarded"}`, ticket — `{externalId:"EXT-7"}`. Все находятся в ns-A/local, кроме явно объявленных remote cases. Типы, Forkable implementations и reference descriptors поставляет fixture.fork, без специальных веток в runtime. Политика root всегда clone; обязательные политики относятся к его ссылкам и вложенным связям. Planning создаёт объект плана; счётчики «new fork objects»/«total durable object count» в fork-тестах считают source+result domain objects, исключая control records плана/invocation/event. Предел 1000 writes, напротив, учитывает каждый реальный write CommitBatch, включая служебные.

Доменная fixture-операция saveList получает в input object, expectedRevision, activeRef и expectedActiveRevision. Эти поля принадлежат схеме fixture.lists, не InvocationRequest. activeRef — ссылка на fixture Head с постоянным собственным типом. MigrationPlan закрепляет source=list-A@rev-red, head=active-list@active-red и новый destination=list-A-v2 типа ChecklistV2; create destination и replace Head выполняются атомарно. list-A старого типа остаётся исторически доступным. Fixture scopes/ns для новой версии задаёт migration package; mounted current view следует обновлённой доменной ссылке, historical view остаётся на старой.

Тесты подписок используют детерминированный barrier доставки, тесты миграций — barrier после чтения revision. Ожидание по фиксированному sleep запрещено. Failpoint после COMMIT прерывает процесс до response/event delivery. Проверка handler counter/UI transport допускает instrumentation hook; бизнес-логика всегда выполняется продуктом.
