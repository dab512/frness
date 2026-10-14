# CLI backend

Минимальная сборка: meta/технические bridges + api + storage + agent-runtime + выбранный provider transport. Она работает без std.execution, LLM, agent-usage и agent-limits. Пример полного профиля: [cli-profile.ts](../tests/support/cli-profile.ts).

```sh
npm run cli:build -- .frness/cli-1
npm run test:atom -- tests/atoms/FH-31.test.ts
```

Session, Turn, Request, Event и Workspace задаются метамоделью agent-runtime. Provider transport — отдельный пакет с собственной Configuration/Event schema. Реализованы Codex `exec --json` и Claude `--print --output-format stream-json`; prompts передаются stdin. Эти варианты используют сохранённую CLI-аутентификацию. Explicit environment bindings разрешаются credential capability; значения секретов не сохраняются в configuration snapshot.

Базовые операции Runner: run, resume, interrupt. Run с прежней Session отправляет новый явно заданный prompt; resume читает handle и не повторяет прежний prompt. Print transports не поддерживают интерактивные permission responses или native fork; соответствующие операции отклоняются до запуска. Базовый transport не включает bypass permissions.

После потери владельца queued turn помечается failed-before-spawn, running turn — unknown. Unknown сохраняет занятость session и не запускается повторно. Read-only replay читает записанные события; это воспроизведение наблюдаемой границы, а не скрытых внутренних шагов CLI. Отсутствие authoritative terminal при exit 0 не считается успехом.

## Независимые расширения

- agent-usage подключается в events.observers. По точному provider Event TypeRef и настроенным JSON paths он создаёт Sample/Summary в своём storage. Unknown usage остаётся null; повтор source/revision не учитывается дважды.
- agent-limits подключается в launch.policy. Текущий пример ограничивает **admitted runs**, фиксируя Reservation/State в собственном storage. Это политика допуска, а не обещание ограничения денежных расходов, токенов или внутренней работы CLI.

Addons можно выключить/заменить, сохранив их данные. Ошибка observer не меняет terminal CLI. ObserverSlot выполняет замену после drain, не перезапуская активный процесс. Общая orchestration hot reload всех пакетов и UI интеграция проверяются последующими FH-30/FH-28.

Тесты используют реальные отдельные fake CLI процессы, реальные SQLite и SIGKILL в пяти cut points. Они не заменяют live-приёмку установленных Codex/Claude, которая остаётся FH-29.
