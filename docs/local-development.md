# Локальный запуск

Требуется Node.js 24, затем `npm ci`. Ядро, API и executor можно проверить без UI и внешней модели:

```sh
npm run test:atom -- tests/atoms/FH-14.test.ts
```

Тест собирает настоящие plugin artifacts, поднимает daemon отдельным процессом, вызывает HTTP/CLI, обрывает ответ после принятия команды, проверяет SSE reconnect и restart. Внешняя фикстура живёт отдельным процессом со своей SQLite; проверяется один physical effect.

Сборка служебных пакетов в новый каталог:

```sh
npm run runtime:build -- .frness/runtime-1
npm run daemon -- /absolute/path/profile.json
```

Профиль содержит bootstrapDirectory/dataDirectory, service assembly, application assembly, principalId, grants по instanceId и credential bindings. Пример состава service assembly: std.api.HttpServer → std.execution-backend.Backend → std.store-sqlite.Storage. Обе сборки проходят тот же nominal linker. Расположение типов/реализаций закреплено полными DefinitionRef из lock; latest не выбирается. Программный пример профиля и его сборки: [daemon-check.ts](../tests/support/daemon-check.ts).

`FRNESS_API_TOKEN` передаётся окружением; binding в профиле содержит имя переменной и список разрешённых instance IDs. Значение credential не входит в профиль, объекты или логи. HTTP слушает 127.0.0.1; CLI передаёт bearer и Origin. UI ещё не реализован.

```sh
npm run frness -- invoke --endpoint http://127.0.0.1:7600 --instance ID --assembly-revision REV --contract-file contract.json --operation run --input-file input.json --key REQUEST_KEY
npm run frness -- inspect --ref-file object-ref.json
npm run frness -- observe --namespace runtime --cursor CURSOR
```

Текущие команды CLI: invoke, inspect, observe. Управление пакетами, backup/restore и UI появятся в соответствующих этапах; наличие спецификации не означает готовности этих команд.
