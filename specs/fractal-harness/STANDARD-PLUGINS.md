# Контракты стандартных плагинов

Имена и данные ниже — стандартная библиотека пакетов. Они не добавляют предметные сущности в host. Формы объектов даны в [standard-contracts.ts](standard-contracts.ts); каждую форму пакет объявляет как TypeDefinition с закрытой JSON-схемой. Общие envelopes/ошибки — [contracts.ts](contracts.ts). Версии и digest назначаются сборкой, заглушки в runtime запрещены.

## LLM и вопрос–ответ

std.llm.Generate имеет операцию generate: ModelRequest→ModelCompletion. ModelRequest.messages непуст; maxOutputTokens positive safe integer; role=tool требует toolCallId, для других ролей он null. Tools имеют уникальные names и точные схемы аргументов/результатов. OutputType=null разрешает обычный текст; заданный outputType требует валидного structured результата.

ModelCompletion выдаётся только после полного валидного завершения. finish=tool_calls требует непустой toolCalls с уникальными id; finish=stop требует пустой toolCalls. Пустой text допустим при tools/structured; одновременно пустые text, structured=null и tools=[] отклоняются INVALID_OUTPUT. Provider usage неизвестного объёма остаётся null. Length/error/оборванный stream — INCOMPLETE_RESPONSE, а не допустимый finish enum.

Низкоуровневый HTTP provider — effect-adapter.v1 child LLM-компонента. Его configuration задаёт endpoint/model/credential capability и версию decoder; никакие defaults не выбирают внешний сервис сами. Fake provider входит в fixtures. Для первого live adapter исполнитель использует явно настроенный совместимый gateway/provider и документирует его wire-протокол в пакете адаптера до FH-29; неизвестный endpoint/credential — DEPENDENCY_UNAVAILABLE, не попытка подобрать доступы. Это обязательные внешние данные развёртывания, не изменение generic contracts.

std.question-answer.submit принимает ModelRequest и возвращает ModelCompletion через один child generate. Пакет хранит Interaction со ссылками Request/Invocation и предоставляет view. Он не требует Session/Project и не запускает агентский цикл автоматически.

## Tools

std.tools.Invoke.invoke: ToolCall→ToolObservation. Router имеет keyed slot tools, ключ=ToolSpec.name. Результат ошибки тоже observation: ok=false, value=null, errorCode непуст. При успехе ok=true, errorCode=null, value валидируется по ToolSpec.outputType. Неизвестный tool и неверные args — INVALID_INPUT в observation без dispatch; outer invocation может завершиться succeeded, потому что observation сформировано корректно.

Группу calls агент выполняет последовательно в порядке массива для v1. Повтор call.id с другим содержимым отвергается. Возможность параллельного router — другой implementation того же контракта после собственных conformance tests. Инструмент подагента использует тот же Invoke и возвращает AcceptedResult как typed value.

Файловый read/write adapter работает только внутри явно выданного root capability. Read возвращает path/content/contentDigest. Write принимает path/expectedContentDigest/newContent; конфликт исходного содержимого → REVISION_CONFLICT, запись подтверждается чтением. Неизвестный исход внешней записи при crash обрабатывается по adapter reconcile через contentDigest, а не blind retry.

## Агентский цикл

std.agent.Run.run: AgentTask→AcceptedResult. Task.goal непуст; constraints сохраняются в исходном порядке; sources всегда versioned. OutputType обязателен. Required verifiers определяются assembly slot accept, а не полем, которое модель может удалить.

Обязательные slots: context (std.agent.Context.build), decide (std.agent.Decide.decide), actions (std.tools.Invoke.invoke), accept (std.agent.Accept.check). Необязательные: remember и repository. Context.build принимает {task,observations,feedback} и возвращает ContextBundle. Decide.decide принимает {task,context} и возвращает Decision; один implementation использует дочерний LLM с structured output. Actions.calls непусты, id уникальны; candidate.value соответствует task.outputType; blocked.reason и needInput.question непусты.

Состояния внутреннего автомата: buildingContext → deciding → acting/awaitingInput/checking → remembering → done. Они объявляются Type данного плагина. На входе сохранить исходный Task. После tools добавить observations, затем снова context. needInput использует execution.awaitInput и после валидного ответа возвращается к context. blocked сохраняет причину и ожидает явного input/control, не помечает задачу решённой.

Candidate.digest = SHA-256 canonical JSON {value,type,sources}. Accept.check принимает {task,candidate} и возвращает Verification[]. Все обязательные verifier implementations и их exact refs закреплены сборкой; отсутствие ответа хотя бы одного не равно accept. Только все accept с совпадающим digest дают AcceptedResult. Revise/reject/inconclusive возвращают feedback в следующий context до общего step/budget лимита; недостающие внешние сведения могут дать needInput. Самопроизвольная отмена проверок после нескольких неудач запрещена.

Remember — необязательная запись принятого результата. Она выполняется после acceptance evidence. Ошибка remember добавляет warning и не превращает отвергнутый кандидат в принятый; при недоступности общего durable store scheduler останавливается по общему recovery protocol. AcceptedResult содержит фактические verifications и warnings; никакой текст модели не заменяет эти записи.

## Память

std.memory.Recall.recall принимает {query:string,sources:VersionedObjectRef[],limit:integer} и возвращает Knowledge refs плюс их точные revision. Namespace/scope задаёт capability, не поле query. Limit=1..100; пустой query отклоняется. В v1 поиск — детерминированный лексический: Unicode NFKC, toLowerCase, разделение на последовательности Unicode letters/numbers, уникальные слова запроса; score — число совпавших слов запроса в statement. Score0 исключается; сортировка score descending, затем objectId ascending. Непустой sources ограничивает записи этими provenance refs; пустой массив означает все разрешённые записи текущего namespace. Embeddings — дополнительный implementation, не требование MVP.

std.memory.Remember.remember принимает AcceptedResult и возвращает созданные VersionedObjectRef[]. Записи Knowledge обязаны иметь source refs; status=accepted требует принятого evidence. Raw observations допускаются только status=observed отдельной операцией. Retracted/expired knowledge не добавляется в активный context; оно остаётся доступным истории. recordedAt приходит из logged clock, не Date.now внутри reducer. Extraction LLM — child call с общим бюджетом.

ContextBuilder сначала включает goal/constraints и checkpoint, затем допустимые memory/source entries по детерминированному порядку. Лимит задаётся конфигурацией, используемый tokenizer — pinned dependency. Если обязательная часть не помещается, INVALID_INPUT. Optional части пропускаются с omittedSources; потеря полного исходника не маскируется пересказом.

## Сессии, история, вкладки и проекты

| Пакет и operation | Input | Output и семантика |
| --- | --- | --- |
| std.session.create | CreateInput с Session | Новый ObjectRef; Interaction refs существуют и доступны. |
| std.session.append | AppendInput | Новая VersionedObjectRef сессии; child — Interaction; CAS и сохранение порядка; duplicate child не добавляется второй раз. |
| std.session.update | UpdateInput | Новая VersionedObjectRef; общая схема и CAS обязательны. |
| std.history.append | HistoryEntry | VersionedObjectRef записи; subject revision immutable; sourceEventId уникален в данной истории. |
| std.project.create/update | CreateInput/UpdateInput с Project | Собственный namespace и объекты; members — reference links, удаление membership не удаляет target. |
| std.tabs.open | {layout:ObjectRef,expectedRevision,tab:Tab} | Новый Tab ref и layout revision; новый mount создаёт UI при отображении. |
| std.tabs.close | {layout:ObjectRef,expectedRevision,tab:ObjectRef} | Layout revision; только reference removal/unmount, без cancel/purge. |
| std.tabs.select | {layout:ObjectRef,expectedRevision,tab:ObjectRef} | Layout revision; tab должен присутствовать в layout. |
| std.tabs.reorder | {layout:ObjectRef,expectedRevision,tabs:ObjectRef[]} | Та же совокупность tabs в новом порядке; duplicates/missing/extra → INVALID_INPUT. |

HistoryEntry.recordedAt — logged clock. Project.configuration и Session.configuration содержат type+value, каждое value валидируется по указанной exact schema; произвольный patch соседнего plugin config невозможен. При построении assembly порядок конфигурации: явно заданные implementation defaults → project config → session config → явно заданные run overrides, только для полей, разрешённых schema; источник каждого переопределения сохраняется. Результат материализуется в ComponentInstance.configuration и закрепляется assemblyRevision до invoke. Работающий invocation не перечитывает изменившиеся defaults. Input операции проверяется отдельно и не является произвольным config patch. Constraints и capabilities таким слиянием не расширяются.

Когда current-mode объект мигрируется, доменный Head.current обновляется на новый typed объект; этот Head объявлен самим пакетом. Historical views продолжают читать старый ObjectRef/revision. Нельзя автоматически перенаправлять все ObjectRef по совпадению objectId.

## Общие операции данных из reducer

Create/append/update/tabs/memory/fork/migration реализуют логику через чистый reducer и callChild в repository slot по C07. Read/commit store.v1 adapter возвращает typed child result. Политика expectedRevision обязательна; lost response повторяет тот же storage key и возвращает прежнюю ревизию. Прямые SQL/HTTP обработчики с альтернативной логикой этих команд запрещены.

## Conformance пакетов

Каждый пакет предоставляет manifest, closed schemas, implementation descriptors, conformance suite и fixture валидного/невалидного input. Имена OperationRef в таблице стабильны; rename требует новой версии и адаптера. Два независимых implementation одного контракта проходят один suite. Семантика новых предметных типов не добавляется в host ABI.
