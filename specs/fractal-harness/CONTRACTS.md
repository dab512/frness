# Нормативные контракты

Альтернативный CLI agent backend определён в [AGENT-BACKENDS.md](AGENT-BACKENDS.md) и standard-contracts.ts. Это plugin contract, не расширение host ABI и не неявная реализация LLM completion.

Слова MUST, MUST NOT и SHOULD задают обязательность. contracts.ts фиксирует имена и формы wire DTO. Этот файл фиксирует семантику. Стандартные определения Type/Contract/Implementation и остальные DTO поставляются пакетами плагинов; наличие TypeScript interface не делает сущность встроенной в host.

## C01 JSON, схемы и ограничения

Сохраняемые значения — JSON: null, boolean, конечные number, string, array, object с собственными строковыми ключами. undefined, NaN, Infinity, bigint, функции, Date, Buffer и циклические JS-объекты отклоняются до commit. Максимум глубины 64, размер одного входа/сохраняемого объекта 1 MiB UTF-8, batch 10 MiB и не более 1000 writes. Большие артефакты идут через blob adapter и typed reference; молчаливое усечение запрещено.

Используется JSON Schema draft 2020-12. Валидатор не приводит типы, не вставляет defaults и не удаляет поля. Все object-схемы v1 явно задают additionalProperties=false либо явно разрешённую схему дополнительных ключей. Отсутствие и null различаются. Нулевые значения и пустые строки не считаются отсутствием. Ссылки на схемы разрешаются только через TypeDefinition.references и точные TypeRef; сетевое скачивание $ref запрещено. Форматы даты и digest проверяет явно подключённый валидатор.

Ajv регистрирует x-definition-ref и x-sensitive как разрешённые annotation keywords; их семантику дополнительно применяют resolver и projection plugins. Нельзя отключать strict schemas целиком ради неизвестного keyword.

## C02 Пакет и digest

packageId: lowercase сегменты латиницы/цифр, разделённые точкой или дефисом; starts letter. name: ASCII буква, далее буквы/цифры/точка/дефис/подчёркивание. packageVersion — точный semver без диапазона и latest. При сравнении DefinitionRef равны все четыре поля, включая digest.

Артефакт пакета содержит manifest.json, definitions и исполняемые ESM bundles. Файловые пути относительные POSIX, без .., абсолютного префикса и symlink. Вычисление digest: отсортировать пути по UTF-16 порядку JavaScript; для каждого вычислить SHA-256 точных байтов; сериализовать массив пар [path,hexDigest] через JSON.stringify; SHA-256 UTF-8 результата с префиксом sha256:. Отдельный файл package.digest не входит в digest; иных исключений нет. Разрешение экспортов только внутри проверенного артефакта.

Уникальность registry: (packageId, version) → один digest; повтор одинакового пакета idempotent. Конфликт не заменяет запись и не исполняет export. Dependency должна существовать целиком до activation; частичная регистрация невозможна. Удалять определения, на которые ссылаются сохранённые объекты/assembly, нельзя.

Чтобы исключить самоссылку hash, внутри source manifest разрешён SourceDefinitionRef: полный внешний DefinitionRef либо {local: "DefinitionName"}. SourceDefinitionRecord.metaType и reference-поля метасхем, отмеченные x-definition-ref=true, используют этот формат. После вычисления digest linker разрешает local в полную ссылку текущего пакета; результат хранится отдельно от неизменных исходных байтов. Не переписывать исходный пакет и не хешировать resolved projection. Объекты с похожими ключами в произвольных payload не преобразуются. Registry, Assembly, сохранённые объекты и invoke используют только полные ссылки. Самоописание meta.Type использует local ссылку на Type; bootstrap-схема знает только конечные позиции reference markers.

## C03 Bootstrap и метамодель

PackageManifest.reload обязателен: snapshotType (source full/local ref), serverEntry/clientEntry (имена exports либо null). Для каждого присутствующего environment существует reload participant. Snapshot и hooks определены в HOT-RELOAD.md; stateless snapshot.value=null. Registry/ABI adapters и loader resources generation-scoped; обновление in-place опубликованного определения запрещено. ReloadRequest/ReloadReceipt — типы lifecycle-плагина, не host domain classes.

Встроенный host ABI знает только generic records, ссылки, вызов exports и capability handles. Двухпроходный bootstrap: встроенная ограниченная схема проверяет seed → загруженный meta-validator проверяет собственные определения через стандартный API. Seed pinned by digest. Отсутствие/порча seed — fail before plugin activation, без создания предметных сущностей.

Минимальные определения meta-пакета: Type, Contract, Implementation, Slot, Instance, Binding, Assembly. Type описывает данные; Contract — именованные операции с точными input/output TypeRef, declared errors, effects и conformance suite; Implementation — код/композицию с config/state schemas, slots, ABI и capabilities. Новые предметные типы регистрируются как DefinitionRecord и не требуют добавления switch case в host.

Implementation.entry ссылается на имя export в своём manifest. Нужные ABI регистрируются пакетами стандартных мостов. В v1 обязательны reducer.v1 и react-view.v1; их реализация находится вне host. Неизвестный ABI отклоняется до вызова. Исполняемый export должен соответствовать ABI; декларация сама не создаёт семантику.

Полный конечный boot protocol и seed inventory заданы в BOOTSTRAP.md. Дополнительно обязательны effect-adapter.v1 и store.v1. ConformanceSuiteDefinition={entry,targetContract}; entry — server export собственного пакета. Test runner вызывает suite.run(subjectInstanceId,harness), получая {passed,checks:[{id,passed,detail}]}; host не интерпретирует предметные проверки. Частично подготовленный registry не публикуется до второго прохода self-validation и activation checks.

## C04 Linking и заменимость

Сборка проверяется до исполнения: все refs существуют; config соответствует схеме; root существует; IDs уникальны; каждый некорневой instance имеет ровно один owning parent; все достижимы; циклов нет; глубина не более 32, instances не более 10000.

single: min 0 или 1, max 1, order/key отсутствуют. ordered: уникальные order=0..n-1 без дыр, key отсутствует. keyed: уникальные непустые key, order отсутствует. min/max — неотрицательные safe integer, min≤max. Slot name уникально внутри владельца.

Ребёнок MUST явно экспортировать точный accepts ContractRef. Формальная одинаковость входной/выходной схемы не даёт совместимости. Дополнительные экспортируемые контракты разрешены. Эффекты ребёнка ограничены контрактом и capabilities предков. Замена требует повторной валидации и conformance suite. Действующая assembly immutable; patch создаёт новую revision, не меняет старые invocations.

Общие объекты/сервисы передаются ObjectRef и capabilities вне owning bindings. Reference не даёт права читать/писать и не означает каскадное удаление. Новые слоты могут объявляться сторонним ImplementationDefinition; единого закрытого enum имён слотов нет.

## C05 Objects и атомарность

ObjectRef = storeId + namespaceId + objectId + exact TypeRef. Значения ID непрозрачны и не содержат runtime path. Namespace зарегистрирован за парой (ownerInstanceId,scopeId); права контекста проверяются до чтения даже при известном objectId. Неавторизованный запрос получает CAPABILITY_DENIED без утечки existence/revision/value.

Revision — непрозрачная строка, сравнение только на равенство. create требует отсутствия объекта. replace/tombstone требуют expectedRevision. Старые ревизии сохраняются для истории; tombstone не стирает их. Повтор objectId при create — OBJECT_EXISTS. Смена type внутри replace запрещена: миграция создаёт запись по отдельному контракту.

CommitBatch — одна SQLite-транзакция. Вначале проверить права, схемы, readSet и expectedRevision всех writes, затем записать все revisions/events. Любая ошибка отменяет весь batch. readSet содержит текущие ревизии источников; повтор ref в readSet разрешён только с одинаковой revision. Два writes одного objectId в одном batch запрещены. EventId уникален, повтор с другими байтами — EVENT_CONFLICT.

commitKey имеет scope store + principal + scope + ownerInstance. Повтор commitKey и того же canonical payload возвращает прежний receipt, включая revisions и cursor. Другой payload — IDEMPOTENCY_CONFLICT. Идемпотентность проверяется после auth, до CAS, иначе повтор успешной записи ошибочно конфликтует с новой ревизией. Idempotency entries хранятся весь срок существования связанного результата; в v1 автоматического GC нет.

Согласованный snapshot и cursor читаются из одной транзакционной границы. Подписка не теряет событие между snapshot и подключением: события после cursor дочитываются из durable change log. Cursor opaque, его нельзя сравнивать как число. В SubscriptionEvent previousCursor должен совпадать с последним применённым cursor; eventId дедуплицируется. Gap → остановить применение и catch-up; expired cursor → новый snapshot. Late snapshot не откатывает уже применённые live events.

## C06 Canonical payload и ключи идемпотентности

canonical-json-v1: сначала проверить C01; рекурсивно отсортировать object keys через стандартный Array.sort() JS; порядок arrays сохранить; сериализовать JSON.stringify без пробелов. -0 становится 0. Hash = SHA-256 UTF-8 canonical JSON. Этот алгоритм закреплён; изменение создаёт новую версию, старые hash не пересчитываются.

InvocationRequest input проверяется по OperationDefinition до сохранения Request. Для всех публичных invoke idempotencyKey обязателен, 1..128 ASCII символов. Scope ключа: principalId + scopeId + targetInstanceId + operation exact ref. Body hash включает operation, target, input и закреплённую assemblyRevision; права не включаются и проверяются на каждом повторе. Дубликат возвращает исходные Request/Invocation refs. Новый желаемый запуск требует нового ключа.

Request immutable. Invocation фиксирует assemblyRevision, ImplementationRef и TypeRefs. Request и Invocation определяет execution-пакет. Один Request может быть использован для нового Invocation только отдельной операцией repeat с новым idempotencyKey; обычный повтор ingress не создаёт Invocation.

assemblyRevision обязательна в InvocationRequest: UI берёт её из mount, CLI — из выбранной сборки и сохраняет при retry. Сервер проверяет доступ и существование этой revision; не заменяет её текущей активной. Поэтому retry старого запроса после deploy возвращает прежний receipt; изменение assemblyRevision с тем же ключом — IDEMPOTENCY_CONFLICT. Новая пользовательская команда выбирает текущую сборку и новый ключ.

## C07 Execution ABI

Reducer получает plain immutable state/event/config и возвращает state/commands синхронно. Promise, I/O, чтение live clock, random и запись состояния вне commit запрещены. Разрешён явный logged effect для недетерминированных данных. Runtime проверяет вход и результат; исключение reducer → failed без частичных writes/новых effects.

reducer.v1 export — ReducerModule с initialize(input,config) и reduce(state,event,config). initialize — чистая синхронная функция, создаёт per-invocation state по ImplementationDefinition.stateType. После его проверки runtime сохраняет state и initial event execution.InputReceived с InputReceivedValue {invocation,operation,input} одной транзакцией. Каждое новое invocation получает свой state. stateNamespaceId — namespace долгоживущих объектов компонента; reducer получает только своё per-invocation state. Общие данные читаются/меняются через явную repository operation с CAS, а не shared JS объект.

Pure reducer может выделять object IDs детерминированно как SHA-256 canonical JSON [initialInvocationRef,localKey], с явным префиксом obj_. LocalKey уникален в логике операции (например root, child/0). Такие IDs непрозрачны, не зависят от пути assembly и стабильны при replay. Иное случайное выделение ID происходит только через записанный ID-source. Runtime allocation request/invocation/event IDs и epoch принадлежат стандартному execution плагину; исходные значения фиксируются до использования.

Ошибка initialize до принятия invocation не создаёт effects. Детерминированное исключение initialize/reduce имеет код REDUCER_EXECUTION_FAILED; невалидный результат имеет INVALID_OUTPUT. Исключение reduce либо INVALID_OUTPUT откатывает текущий batch, затем отдельная транзакция фиксирует failed invocation и failed/consumed marker исходного inbox event; старое state сохраняется. Ошибка/падение самой storage transaction оставляет event pending для восстановления. Этот предел не допускает бесконечного повторения poison event. Если failure commit также упал, процесс останавливает scheduler до восстановления store.

Cancel до dispatch разрешает переход Attempt prepared→failed_known с кодом CANCELLED_BEFORE_DISPATCH, evidence control commit и actualUnits=0. Переход и settlement через CAS исключают гонку с dispatch. Отправленные/unknown attempts таким способом не обнуляются. После завершения этого bounded cleanup исторические attempts не препятствуют fork quiescence.

effect command адресует adapterInstanceId непосредственного ребёнка, подключённого в объявленный слот текущего instance. Его ABI обязан быть effect-adapter.v1 и контракт operation обязан быть экспортирован им. Голый ImplementationRef и произвольный sibling не являются разрешённой целью. EffectDefinition сохраняет разрешённые adapterInstanceId, exact adapter ImplementationRef, immutable adapterConfiguration и accountRef из capability binding. AccountRef непрозрачен; реальные credentials не копируются. Retry/resume не могут переключить account или config; ротация credential допустима только для того же account.

EffectAdapter.execute/reconcile возвращают EffectOutcome. Throw/transport timeout интерпретируются как unknown, если нет подтверждённого adapter evidence об отсутствии внешнего действия. reconcile никогда не повторяет запись; он читает/уточняет прежний результат. Если adapter не поддерживает reconcile, возвращает unknown. actualUnits=null означает, что reserve не освобождается. ReservationRecord и EffectResolutionRecord — типы execution-плагина; уникальность effectId у resolution даёт одну логическую доставку reducer при нескольких физических attempts.

commandId уникален в пределах invocation и детерминирован по logical step; повтор того же event и commands не создаёт новых children/effects. Runtime связывает slot/key/order только с текущей pinned assembly; reducer не вызывает произвольного sibling. complete/fail должны быть единственной командой batch, иначе INVALID_COMMAND_BATCH. complete запрещён пока есть незавершённые child/effect или unresolved effect; отмена — отдельная control operation.

Локальные repository operations выполняются через callChild в слот с точным std.storage.Repository contract; child Implementation имеет ABI store.v1. Операция read принимает {object:ObjectRef,revision?:Revision} и возвращает ObjectRecord. Операция commit принимает {batch:CommitBatch} и возвращает CommitReceipt. Контекст principal/scope/owner/grants передаёт runtime от вызывающего компонента через его repository capability; поля input не могут его заменить. Child имеет свой Invocation, результат/ошибка сохраняются и доставляются родительскому reducer как execution.ChildCompleted либо execution.ChildFailed. Type этих событий включает commandId и output/error. Async read/commit исполняется bridge вне чистого reducer; произвольный SQL/JS I/O внутри reduce не разрешается.

Для child commit reducer задаёт input.batch.commitKey равным своему commandId; другое значение — INVALID_INPUT. Bridge заменяет его на технический ключ repo/ плюс SHA-256 canonical JSON массива [parentInvocationId,commandId]. Reducer не обязан знать runtime ID своего invocation. Данные, revisions, journal и storage commit receipt атомарны внутри ObjectStore.commit. Сохранение execution ChildCompleted может идти следующей транзакцией: crash между ними повторяет тот же storage commitKey и получает прежний receipt, без повторной мутации. До durable ChildCompleted родитель не делает следующий шаг. При local read bridge сохраняет точный прочитанный ObjectRecord/Revision в child result; до сохранения результата read допустимо повторить, после — повторно не читать latest.

Replay использует сохранённые child repository результаты: не читает изменяемые live records и не пишет рабочие namespaces; simulation writes при необходимости идут только в scratch. Реализация remember/completeItem/fork/migration сначала завершает repository child, затем отдельным reducer событием формирует свой result. Таким образом local mutation, как и внешнее действие, может стать видимой раньше terminal invocation; долговечный commit receipt гарантирует восстановление. Нельзя объявлять невидимость данных до terminal phase или автоматически откатывать уже подтверждённый commit.

awaitInput сохраняет ожидаемый TypeRef и commandId. Ответ пользователя — отдельный idempotent input event, валидируемый по схеме. Недействительный ответ не выводит invocation из waiting. Команда «показать статус» только читает состояние и не останавливает выполнение.

Полный lifecycle, retry, budget и crash protocol — RUNTIME.md. Единственная допустимая разница «успех/принято»: succeeded означает валидное завершение операции; AcceptedResult агента требует verifier evidence на тот же candidateDigest. Проверка, вернувшая reject, сама может быть succeeded.

## C08 API и автоматизация

Transport стандартного api-плагина: POST /v1/invoke принимает InvocationRequest и возвращает InvocationReceipt (202); GET /v1/objects/read принимает ссылку через кодированный JSON query и возвращает авторизованную проекцию; POST /v1/subscriptions возвращает snapshot+cursor, GET /v1/events отдаёт SSE с eventId/cursor. Имена предметных команд в URL отсутствуют. Control/registry/object operations описываются теми же Contract/Operation definitions.

Ошибки: JSON {code,message,details,retryable}. INVALID_INPUT=400, CAPABILITY_DENIED=403, NOT_FOUND=404, REVISION_CONFLICT/IDEMPOTENCY_CONFLICT=409, DEPENDENCY_UNAVAILABLE=503; остальные валидируемые ошибки 422. Ошибка внутри уже принятого invocation отражается в его состоянии и событии, не меняет ранее полученный HTTP receipt.

CLI использует тот же API: invoke --instance ID --contract REF --operation NAME --input-file FILE --key KEY; inspect REF; observe --cursor CURSOR; plugin stage/activate/disable; assembly validate/run; backup/restore. Значения file args читаются как данные, не исполняются shell. Человек, CLI и агент с одинаковым правом получают одинаковую семантику операции.

SSE обеспечивает наблюдение, не запускает повторную обработку команд. Disconnect/unsubscribe не отменяет принятый invocation. Клиент после transport timeout повторяет тот же idempotencyKey и payload. Локальное управление pause/cancel/resume идёт отдельными описанными операциями.

## C09 UI и хранение представления

ViewDefinition принимает точный targetType и propsType. Выбор view задан explicit binding; fallback Inspector поставляется отдельным стандартным плагином. Порядок обнаружения пакетов не выбирает renderer. Mount хранит object ref и optional fixedRevision; current mode получает новые данные, historical mode остаётся на версии.

Единственный источник слотов — ImplementationDefinition.slots. ViewDefinition не копирует slots. ViewMount содержит viewInstanceId и assemblyRevision; implementation этого instance обязана совпадать с ViewDefinition.implementation. react-view.v1 export — React function component, получающий {mount,targetSnapshot,props,context}. context предоставляет invoke, observe, localViewState и renderSlot({slot,key?,order?,props}). renderSlot разрешает только pinned bindings текущего viewInstanceId и проверяет propsType ребёнка; default target наследуется от родительского mount. Новый target передаётся явно и проверяется по targetType/access ребёнка. Child mount identity стабильно выводится из parent mount ID + binding identity, а не target object ID. Два mounts одного viewInstanceId не разделяют localViewState.

ActionDefinition ссылается на OperationRef; inputType обязан равняться схеме операции. View получает invoke/observe/localViewState через capability context. UI не пишет host store напрямую. Unmount освобождает подписки и local resources; выполнение и сохранённые объекты остаются.

Клиентский bundle использует один host React. Каждый плагин имеет error boundary. Ошибка renderer не меняет предметные данные и отображается через доступный Inspector/ошибку mount. Неизвестная версия не передаётся несовместимому renderer.

Приватные значения отмечаются x-sensitive в схеме. Общий inspector/логи/export по умолчанию маскируют такие поля. credential material не является обычным JSON record; только capability reference. Экспорт полного разрешённого состояния — отдельная явно разрешённая операция.

## C10 Fork и миграции

Fork — отдельный плагин. Тип предоставляет Forkable implementation либо планирование отклоняется. По каждой связи обязательна clone/reference/reset/reject политика. ForkPlan immutable, фиксирует readSet конкретных версий, заранее выделенные target IDs и digest. planFork не создаёт целевые предметные объекты.

executeFork сначала проверяет idempotency, затем readSet CAS и quiescence: отсутствуют активные дочерние исполнения, prepared/dispatched/unknown effects и незавершённые migrations. Успех одной транзакцией создаёт весь целевой граф и provenance. Изменившийся источник → REVISION_CONFLICT и ноль target writes. Для v1 нельзя fork historical revision, если актуальная версия источника изменилась после planFork; новый план обязателен.

Под service writes в лимите 1000 понимаются элементы CommitBatch.writes, включая явно добавленные plugin/runtime object records. Внутренние SQL rows revision/index/commit-receipt не являются дополнительными элементами массива writes. Этот предел не отменяет общий лимит 10 MiB.

Clone переназначает внутренние owned refs, reference сохраняет исходную ссылку, reset использует явно указанную чистую фабрику defaults. Новые scopes не получают права сверх исходных. Внешние effects при plan/execute запрещены. Fork внешней рабочей среды — последующая отдельно разрешаемая операция, не скрытая часть fork сессии.

В v1 повторяющиеся ссылки на один source разрешены только с одинаковой policy/target; конфликтующие политики → FORK_UNSUPPORTED. Owned relation нельзя переносить как reference с сохранением нового владения. Весь fork, включая service records/provenance/events, должен укладываться в C01; превышение 1000 writes отклоняет план с PAYLOAD_TOO_LARGE. Частичные форки по нескольким транзакциям в v1 запрещены.

Миграция использует exact source/target TypeRef, pure implementation и readSet CAS. Данные неверной схемы не сбрасываются к defaults. Старые версии сохраняются; новый код запускается на новом snapshot/namespace. Dirty UI draft не перезаписывается и не может по старой revision откатить schema.

Точный механизм: migration operation создаёт новый objectId с target TypeRef и одним CommitBatch переключает явно объявленный plugin-owned Head reference через expectedRevision. Исходный object immutable для истории миграции. Head имеет стабильный собственный тип и указывает на актуальный typed object. При необходимости нового namespace он предварительно резервируется без публикации данных. Ни replace, ни произвольный client не меняют type существующего ObjectRef. Ошибка create или head CAS откатывает обе записи.

## C11 Каталог обязательных ошибок

BOOTSTRAP_PACKAGE_MISSING, DIGEST_MISMATCH, DEFINITION_CONFLICT, PINNED_DEPENDENCY_MISSING, UNKNOWN_ABI, INVALID_INPUT, INVALID_OUTPUT, INVALID_COMMAND_BATCH, INVALID_TRANSITION, NON_JSON_VALUE, PAYLOAD_TOO_LARGE, CONTRACT_MISMATCH, UNKNOWN_SLOT, SLOT_CARDINALITY, DUPLICATE_SLOT_KEY, DUPLICATE_SLOT_ORDER, MULTIPLE_OWNERS, OWNERSHIP_CYCLE, UNREACHABLE_INSTANCE, CAPABILITY_DENIED, OBJECT_EXISTS, NOT_FOUND, REVISION_CONFLICT, IDEMPOTENCY_CONFLICT, EVENT_CONFLICT, COMPLETION_CONFLICT, DEPENDENCY_UNAVAILABLE, UNSUPPORTED_SCHEMA_VERSION, PLUGIN_DISABLED, LIVE_REFERENCES, VIEW_UNAVAILABLE, CURSOR_EXPIRED, SNAPSHOT_UNAVAILABLE, FORK_UNSUPPORTED, CHECKPOINT_NOT_FORKABLE, WRITER_ALREADY_RUNNING, BUDGET_EXCEEDED, INVALID_USAGE, EXTERNAL_OUTCOME_UNKNOWN, INCOMPLETE_RESPONSE, VERIFICATION_REJECTED, VERIFICATION_INCONCLUSIVE, REPLAY_DIVERGENCE.

Bootstrap errors принадлежат ABI; остальные error definitions поставляются стандартными пакетами. Нельзя возвращать success с error внутри произвольного объекта вместо объявленного failure. retryable означает возможность повторить запрос по правилам, не разрешение автоматически повторить неизвестный внешний effect.

Hot reload errors: RELOAD_PREPARE_FAILED — capture/restore/ready/compile не прошёл; RELOAD_LIMIT_EXCEEDED — новая generation превышает допустимое удержание ресурсов. Ошибка до publication сохраняет прежнюю active generation и данные. Семантика полного reload protocol — HOT-RELOAD.md.

Дополнительные коды: REDUCER_EXECUTION_FAILED — исключение чистой initialize/reduce; CANCELLED_BEFORE_DISPATCH — доказанная локальная отмена prepared attempt до разрешения транспорта.
