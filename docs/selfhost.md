# Минимальный self-host

Из корня репозитория (Node 24, установленный и авторизованный Codex или Claude):

```sh
npm ci
npm run selfhost -- --provider codex --workspace . --prompt-file TASK.md
```

TASK.md задаёт конкретную небольшую задачу. Агент получает рабочую директорию и обычные возможности своего CLI. Вывод ответа печатается по мере сохранения текста. Ctrl-C вызывает interrupt принадлежащего запуску процесса. Ошибка или неизвестный результат возвращает ненулевой exit code; неизвестное действие автоматически не повторяется.

Состояние находится в `.frness/selfhost/data`, результат — `.frness/selfhost/last-run.json`. Для следующего сообщения той же native сессии:

```sh
npm run selfhost -- --provider codex --workspace . --prompt-file NEXT.md --session-file .frness/selfhost/last-run.json
```

Один активный launcher на рабочую директорию. Неизвестная активная native сессия после аварии требует ручного разбора; не запускайте тот же эффект повторно вслепую. Сборки сохраняются в `.frness/selfhost/builds` для закреплённых ссылок.

Локальный доверенный модуль подключается через `--extension ./path/extension.ts`. Его default export реализует `SelfhostExtension` из apps/cli/src/selfhost.ts: `packages` добавляет метаописания и код, `extend({profile,ref})` добавляет экземпляры, bindings, namespaces и grants. Host менять не требуется. Модуль выполняет обычный код Node и имеет права пользователя.

Минимальная сборка включает только метамодель, технические bridge-контракты, SQLite, CLI runtime и выбранный transport. Лимиты, статистика, managed LLM, память и UI не включаются. Полный hot reload ещё не реализован; активная compiled-сборка расширения применяется к следующему turn после проверенного install/request, без рестарта Electron. Полный системный hot reload в активном invocation пока не реализован.

Проверки bootstrap: fake CLI выполняет реальный OS-процесс; проверены continuation, interrupt, missing executable и подключение существующего observer через extension hook с записью в отдельный SQLite. Это проверка механизма расширения. Создание нового плагина live-агентом пока не подтверждено: Codex сообщил отказ командных инструментов; пробный Claude был отменён до правок. Политики разрешений CLI не изменены.

Полный рабочий workflow разработки, writer lease, `plugin scaffold/install/request/status`, владение данными и границы reload описаны в одном [AGENT-GUIDE.md](../AGENT-GUIDE.md). CLI `--mode workspace` — явный выбор Codex never + workspace-write для данного запуска; global config не меняется.
