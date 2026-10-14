# Приёмка и тестовые оракулы

Тесты проверяют наблюдаемое поведение, записи состояния и реальные обращения к fake transport. Статус пакета: продукт отсутствует; Gherkin и executable contract suite подготовлены для реализации. Проверка синтаксиса тестов не является прохождением acceptance.

## Исполняемый набор

tests/acceptance.test.mjs содержит 14 black-box тестов. Адаптер реализует acceptance-api.ts в packages/acceptance-adapter. Команда: FRACTAL_SUT_MODULE=/absolute/path/to/packages/acceptance-adapter/dist/index.js npm run test:acceptance из этой папки. Без адаптера ожидается IMPLEMENTATION_MISSING и ненулевой код, а не skipped/green.

Эти 14 тестов не заменяют остальные сценарии. Все группы ниже и все @RT/@UI в feature files обязательны для final gate. Будущий исполнитель реализует их в соответствующих package tests либо Playwright, сохраняя IDs в названиях. Отдельный файл tests/FIXTURES.md задаёт реальные fixture-пакеты и внешний процесс fake remote.

## Метамодель и linker

| ID | Дано и действие | Оракул |
| --- | --- | --- |
| META-001 | Пустой каталог; отсутствует pinned meta bundle; boot | BOOTSTRAP_PACKAGE_MISSING; ноль activation предметных плагинов, данных и effects. |
| META-002 | Пакет с local ссылками Type→Type и A↔B; install дважды | Один digest, полные разрешённые refs, source bytes неизменны. Изменение одного байта меняет digest; payload {local:"x"} вне ref position не переписывается. |
| META-003 | Два контракта одинаковой формы с разными names/versions; child во второй слот | CONTRACT_MISMATCH; ноль child calls. Явный adapter с требуемым exact ref разрешён. |
| META-004 | Один child уже в body; добавить в other | MULTIPLE_OWNERS. Отдельные instances на общем store разрешены и не делят state. |
| META-005 | Slot name не объявлен в owner definition | UNKNOWN_SLOT до startup exports; assembly не публикуется. |
| META-006 | Установлен package@1 с digest A; предлагают другой payload под тем же version | DEFINITION_CONFLICT; версия A и активные invocations неизменны. Подменённый artifact до install → DIGEST_MISMATCH. |
| META-007 | A owns B owns A; orphan C; глубина 33 | OWNERSHIP_CYCLE / UNREACHABLE_INSTANCE / INVALID_INPUT соответственно. Межобъектные reference cycles не становятся owning edges. |
| META-008 | ordered positions 0,2; keyed два key=x; required slot пуст; install order reversed | DUPLICATE_SLOT_ORDER для дыр/повторов, DUPLICATE_SLOT_KEY, SLOT_CARDINALITY; валидный explicit order не зависит от installation order. |
| META-009 | Незнакомый ABI или required capability отсутствует | UNKNOWN_ABI или CAPABILITY_DENIED; код реализации не вызывается. Raw ImplementationRef вместо connected effect child отклоняется. |
| META-010 | Pure counter reducer вызван дважды на одном instance | Два независимых invocation state; долгоживущий object меняется только явным store commit; initialize output проверяется по stateType. |

## Storage

| ID | Дано и действие | Оракул |
| --- | --- | --- |
| STORE-001 | Document {count:0}, два replace с одной revision | Ровно один успех, второй REVISION_CONFLICT; old revision всё ещё {count:0}. |
| STORE-002 | Batch create B + replace A со stale revision | Ни B, ни новый A, ни change event не сохраняются. |
| STORE-003 | Повтор commitKey с тем же batch после успеха, затем с изменённым payload | Тот же receipt; затем IDEMPOTENCY_CONFLICT; не более одной новой ревизии. |
| STORE-004 | Лишнее поле, строка вместо integer, null вместо required integer | INVALID_INPUT без stripping/coercion/defaults; original revision неизменна. |
| STORE-005 | Два owner instances в одном физическом SQLite; одинаковые objectId | Изолированные данные. Попытка прочитать чужой namespace возвращает CAPABILITY_DENIED без existence/revision. |
| STORE-006 | 1 MiB+1 вход, 1001 writes, JSON depth65, NaN/undefined/function | PAYLOAD_TOO_LARGE или NON_JSON_VALUE до commit. Граничные разрешённые значения сохраняются без усечения. |
| STORE-007 | state+event commit, host падает до уведомления; reconnect | Авторитетный snapshot/catch-up показывает ровно одну новую revision/event. Read и cursor не создают window потери события. |
| STORE-008 | Один eventId дважды с одинаковыми данными; затем иными | Идемпотентная доставка; конфликт → EVENT_CONFLICT без перезаписи. Один object дважды в batch → INVALID_INPUT. |

## LLM, цикл, инструменты и память

| ID | Дано и действие | Оракул |
| --- | --- | --- |
| AG-001 | Только single-call assembly, fake ответ "42" | Ровно один provider call; возвращён "42"; Session/Project/UI tabs пакеты не требуются. |
| AG-002 | Модель запросила неизвестный tool либо args не соответствуют схеме | Tool не исполняется; typed observation об ошибке возвращается циклу; bounded retry, не бесконечный loop. |
| AG-003 | LLM adapter без endpoint/credential capability; попытка start | DEPENDENCY_UNAVAILABLE до provider call; credential не попадает в output/log/export. |
| AG-004 | Fake model: tool call → корректный ответ; verifier принимает | Один tool effect; ответ принят только с matching candidateDigest и точными verifier refs. |
| AG-005 | В памяти противоречивые записи с разными scope/source/revision | Чужой scope исключён; противоречие не превращается в уверенный факт; в context сохранены provenance и версии выбранных записей. |
| AG-006 | Контекст превышает лимит, compactor включён | Goal/constraints/checkpoints обязательны и не теряются; обрезка артефакта хранит ссылку на исходник. Если обязательная часть не помещается — INVALID_INPUT, без скрытого удаления ограничений. |
| AG-007 | Model partial stream, verifier reject, затем session remember | Accepted knowledge не создаётся из partial/rejected; сырые события могут сохраняться с непроверенным статусом. Memory-extractor LLM расход входит в общий budget. |
| AG-008 | Model повторяет одинаковое решение, либо превышает depth/steps | Остановка с BUDGET_EXCEEDED и сохранённым прогрессом; status request не завершает работу. Никаких дополнительных calls после лимита. |
| AG-009 | Файловый инструмент получает ../outside, absolute path вне разрешённого root или symlink escape | CAPABILITY_DENIED до чтения/записи; разрешённый файл читается/изменяется с read-back проверкой. |
| AG-010 | Настроен реальный provider; single-call вопрос, затем один tool+verification сценарий | Реальный результат подтверждён; recorded refs/usage без credential; локальный UI показывает итог. Отсутствие credential → gate blocked, не pass. |

## Эксплуатация и структурные проверки

| ID | Дано и действие | Оракул |
| --- | --- | --- |
| OPS-001 | Чистый temp home; install/build/run default profile | Один документированный запуск; health сообщает registry/store readiness; второй writer отвергается. |
| OPS-002 | Stage candidate с плохой схемой/client bundle | Active assembly и running invocations прежние; candidate не публикуется; диагностика указывает package/definition. |
| OPS-003 | Обновление while invocation waiting, затем resume | Старый invocation использует pinned code/config; новый — новую assembly; package purge при live refs даёт LIVE_REFERENCES. |
| OPS-004 | Consistent backup, restore в пустой home | Сохраняются records/revisions/refs/lock/journal/idempotency; active effects не dispatch до явного resume. Credential values не входят в portable backup. |
| OPS-005 | API/CLI/UI вызывают одну command с одним key; invalid Origin или отсутствующий token | Разрешённые вызовы дают один receipt; неавторизованные отклонены; headless операции не зависят от mounted UI. |
| OPS-006 | Проверка dependency graph и source imports | packages/host не импортирует plugins; нет Session/Project/Invocation domain switches/SQL columns в host; server graph не содержит React, client graph — Node builtins. |
| OPS-007 | Плагин с собственным type/store/view/slot, затем сторонний badge | Ноль ручных изменений host/shell; после restart данные и bindings сохранены; 2 mounts независимы; disable renderer не удаляет данные. |
| OPS-008 | Неожиданное исключение renderer или cleanup | Error boundary сохраняет остальные views; cleanup выполняется один раз на владельца, subscriptions освобождаются; execution продолжает работу. |

## Полный gate

BOOT-001…012 из BOOTSTRAP.md; META-001…010, STORE-001…008, AG-001…010, OPS-001…008, RT-001…025 и UI-001…024. Scenario Outline исполняется для каждой строки Examples; все дополнительные Scenario с тем же ID тоже обязательны.

Запрещено объединять crash before/after commit в один happy-path тест. Счётчики transport calls и remote mutations проверяются раздельно. Gherkin фиксирует ожидаемое поведение; adapter и step bindings не имеют права возвращать готовые ожидаемые значения.

Протокол evidence каждого теста включает ID, revision сборки, seed fixture, exit code, relevant invocation/effect IDs и путь к логу. Final evidence отдельно перечисляет automated checks, browser checks и live-provider gate.
