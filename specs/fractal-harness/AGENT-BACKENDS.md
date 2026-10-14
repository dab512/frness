# Исполнительные backend-плагины

Дополнение от 2026-10-14: минимальная сборка выполняет отдельный LLM-вызов либо запускает готового CLI-агента. Один технический host обслуживает оба профиля. `std.agent-runtime` определяет backend, native session/turn, permission request, нормализованные события и их storage через метамодель. Отдельные adapter-пакеты подключаются в типизированный transport slot; provider IDs — данные плагинов, без switch в host/web shell.

Уточнение пользователя: базовый CLI backend отвечает за start/input/events/result/interrupt/resume. Лимиты, usage, стоимость, статистика, проверки и долговременная память подключаются самостоятельными плагинами. Минимальная CLI-сборка работает без них. Backend не владеет их сущностями, счётчиками, политиками или namespaces.

LLM completion, управляемый нашим reducer агентский цикл и внешний CLI-агент имеют разные точные контракты. Похожий текстовый результат не даёт совместимости. Вопрос–ответ выбирает явную operation binding с адаптером результата; CLI-only профиль не зависит от `std.llm` или `std.agent`. DTO объявлены в [standard-contracts.ts](standard-contracts.ts).

## Backend contract

| Слот базового плагина | Контракт | Cardinality | Назначение |
| --- | --- | --- | --- |
| transport | ProviderTransport | single, 1 | Запуск и протокол выбранного CLI. |
| launch.policy | LaunchGate | single, 0..1 | Подключаемая проверка перед запуском; без binding запуск разрешён обычным caller capability. Gate-плагин может объявить свои дочерние слоты. |
| events.observers | EventObserver | keyed, 0..N | Независимые подписчики на сохранённые события: usage, статистика, история, аудит. |

Каждый контракт имеет точный DefinitionRef и conformance suite. Gate возвращает allow/deny; решение и его данные принадлежат gate-плагину. Observer получает immutable event reference и сохраняет cursor/производные данные в своём namespace. Его ошибка или отключение не отменяет результат CLI. Подписчики восстанавливают пропуски через общий subscription protocol. Статистика не требует изменений provider transport или host.

Точные операции расширений: `LaunchGate.check(AgentTurnInput) → AgentLaunchDecision`; `EventObserver.observe(AgentObservedEvent) → null`. Gate exception отклоняет этот запуск до spawn; observer exception фиксируется у подписчика и не меняет CLI terminal. Встроенные addons используют те же контракты, что сторонние. Базовый пакет не импортирует их реализации. В durable execution учёт подключается через optional BudgetPort, поэтому реализация ledger тоже заменяема.

Операции: discover, create, resume, startTurn, observe, interrupt, respondPermission, close. Provider transport реализует только объявленные capabilities; неподдерживаемая операция возвращает `UNSUPPORTED_OPERATION` до отправки. Первые adapters — Claude Code и Codex; protocol/version mappings проверяются по установленным CLI. Транспорт может быть JSONL stdio, SDK, app-server/RPC либо явный ACP adapter. PTY transcript не заменяет структурированный terminal event.

Native session хранит непрозрачный handle, pinned adapter/config/assembly revision, scope и working-directory identity. PID не является долговечной идентичностью. stdout/stderr ограничены по размеру; parser поддерживает byte-fragmented Unicode и несколько frames в chunk. Malformed/oversize frames отклоняются. Unknown event не становится assistant text или completion. Raw provider payload публикуется только через typed redacted projection.

## Исполнение и восстановление

Этот раздел описывает сборку с durable-execution/replay расширениями. Базовый backend предоставляет процесс и события; подключённые расширения добавляют journal/recovery/replay. Простая сборка start→result запускается без этих дополнительных политик. Базовая защита от двойного активного turn и адресация interrupt сохраняются в transport.

Execution фиксирует intent, client turn ID и input до spawn/send. Backend journal сохраняет native IDs и события с дедупликацией и durable cursor. Публикация в UI следует за commit. Позднее появление native turn ID не позволяет запустить второй runner. Один native session допускает один активный turn.

Idempotency key харнеса не доказывает idempotency CLI. Crash между send и durable ack даёт unknown outcome; автоматический повтор запрещён. Reconcile по native IDs допустим только при заявленной и проверенной capability. Resume загружает сохранённую сессию и не пересылает последний prompt.

Stopping хранит stop boundary. Новый turn не отправляется до terminal предыдущего и settlement всех его cancel requests. Поздний cancel не должен убить следующий turn. Double stop адресует ту же границу; cancel failure сохраняет unknown/stopping и закрытый start gate. Permission response не блокируется ожиданием stop, чтобы не создать deadlock.

Exit 0 без authoritative completed event не означает succeeded. Timeout, signal, protocol error, process exit и abort различаются. Убийство subprocess не откатывает его файловые/сетевые эффекты. Process capability завершает только доказанно принадлежащие runner процессы, не широкий набор PID.

Replay читает нормализованную трассу в scratch store: ноль spawn, CLI RPC и рабочих filesystem writes. Скрытые внутренние шаги внешнего агента не объявляются воспроизводимыми. Fork не разделяет mutable native handle между ветками: native fork требует capability и изолированного workspace; иначе новая сессия с явным переносом контекста либо `UNSUPPORTED_OPERATION`.

## Полномочия, лимиты, reload

Executable, argv и env формирует установленный adapter через process capability. Prompt передаётся данными, shell=false; cwd проверяется по scope policy до spawn. Авторизация — штатным CLI/provider credential mechanism. Содержимое auth-файлов, токены и секреты не входят в records, argv, journal или ошибки; бинарники и auth не меняются неявно.

Permission request становится typed waiting-input с request ID, turn ID, digest действия и точными вариантами. Response проверяет caller grants/scope/pinned turn/актуальность. Нет неявного bypass/approve-all. Подключённый policy-плагин управляет дополнительными ограничениями. Плагин лимитов выбирает доступный механизм: native provider option, проверка до старта, interrupt через объявленную операцию. Он описывает, какие ограничения способен гарантировать, и отклоняет неподдерживаемую собственную конфигурацию. Backend не требует наличия такой политики.

Provider-specific usage приходит обычным typed provider event. `agent-usage` определяет UsageSample/UsageSummary, извлекает сообщённые значения и хранит их отдельно; отсутствие данных остаётся unknown. `agent-limits` определяет LimitPolicy/Reservation/LimitDecision и подключается к launch.policy и events.observers. Эти пакеты можно заменить, выключить или hot reload независимо от backend. Их UI тоже является их расширением. Процесс работает при отсутствии обоих пакетов; обязательность политики задаёт только выбранная сборка.

Instance владеет transport resources. Hot reload публикует новую generation для новой работы; активный turn держит прежнюю. Restore не создаёт второго процесса; handles/cursors сохраняются. Closing UI не останавливает runner. Новый executable/protocol/config требует pinned revision; resume проверяет совместимость. Все профили используют общий execution/API/UI lifecycle со своими conformance suites.

## Обязательные edge cases

| ID | Проверка | Оракул |
| --- | --- | --- |
| CLI-001 | CLI-only boot без LLM; два exact adapter contracts | Fake subprocess отвечает через generic API; provider не требует edits host/shell; несовместимый transport отклонён. |
| CLI-002 | Missing/non-executable binary, неверная cwd, probe timeout/version | Типизированная ошибка; ноль turns и credential dumps. |
| CLI-003 | Byte-fragmented Unicode, несколько frames/chunk, invalid/oversize JSON, stderr flood | Порядок и bounded memory; invalid protocol failed/unknown без false success. |
| CLI-004 | Duplicate/conflicting event ID, reconnect/gap/expired cursor | Dedup либо EVENT_CONFLICT; catch-up/snapshot сохраняет terminal и drafts. |
| CLI-005 | Crash до spawn/после spawn/после send до ack/до native ID commit | Нулевой либо один remote turn; uncertain outcome не повторяется; resume не пересылает prompt. |
| CLI-006 | Interrupt pending start; поздний cancel; double stop; cancel failed | Новый turn ждёт boundary; старый cancel не убивает следующий; failure не открывает gate. |
| CLI-007 | Chooser/deny/stale permission/чужой scope/auth missing | Только актуальное разрешённое решение, без bypass и raw secrets. |
| CLI-008 | Exit 0 без completion/nonzero/signal/duplicate terminal | Нет ложного succeeded; один terminal; unknown различим. |
| CLI-009 | Resume/replay/fork/reload удерживаемого turn | IDs/pins сохранены; replay не spawn; ветки не делят session; reload не дублирует runner. |
| CLI-010 | Live Claude Code и Codex: prompt/stream/terminal/resume/interrupt | Evidence для каждой установленной версии; missing binary/auth — blocked live check, fake не заменяет. |
| CLI-011 | Минимальный backend без limits/usage; подключить, выключить и заменить каждый addon | Start/stream/result работают без addons; данные addon в своём namespace; исходники backend/host не меняются. |
| CLI-012 | Gate deny; observer exception; отсутствие usage; hot reload addon на активном turn | Deny до spawn; observer failure не теряет terminal; нет выдуманного нулевого usage; runner не перезапускается при смене addon. |

Fake runner — отдельный ОС-процесс с управляющим каналом и счётчиком turns; mocked spawn не закрывает CLI-001…009. Live prompts выполняются в изолированном workspace с существующими правами. Probe показывает наличие auth, не выводит credential material.
