# Electron bootstrap

Из корня FRNESS, Node 24:

```sh
npm ci
npm run desktop -- --workspace /path/to/repository
```

В окне выберите Codex или Claude Code, введите задачу и нажмите «Отправить». Нужен установленный и авторизованный CLI выбранного агента. Следующий запрос продолжает native сессию; «Новый диалог» начинает новую. «Остановить» вызывает interrupt FRNESS. Закрытие окна не прерывает работу: откройте приложение снова через Dock. Выход из приложения во время запуска ждёт завершения агента.

Доверенный локальный пакет можно подключить при старте:

```sh
npm run desktop -- --workspace /path/to/repository --extension /path/to/extension.ts
```

Это тот же SelfhostExtension и тот же runtime, что у [CLI](selfhost.md). В bootstrap нет вкладок, проектов, форков, полного UI slot renderer или hot reload. Оконная оболочка не вводит новых доменных сущностей: UI-расширения из полной спецификации остаются backlog. Текущий диалог сохраняется в памяти оболочки при закрытии окна; durable объекты агента находятся в `.frness/selfhost/data`. Восстановление видимой переписки после выхода из приложения пока не реализовано.

Electron main запускает Node worker; native SQLite используется системным Node 24 без пересборки под Electron. Renderer загружает только локальные файлы, не имеет Node integration и общается через ограниченный preload API. См. [Electron: context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation/).

Проверки UI: `npm run test:desktop` запускает настоящий Electron через [Playwright Electron](https://playwright.dev/docs/api/class-electron). Требуется графическая сессия ОС. Для тестов используются настоящий runtime, SQLite и fake CLI-процесс; live LLM не вызывается.
