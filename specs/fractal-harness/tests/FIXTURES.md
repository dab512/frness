# Контрольные пакеты и тестовые ресурсы

Фикстуры устанавливаются теми же registry/loader API, что реальные плагины. Acceptance adapter может создавать пакеты и соединять их через публичный API, но не реализует проверяемую логику registry, store, runtime, budget или replay. Каждая фикстура имеет version 1.0.0, корректный вычисленный digest, собственный namespace и точные refs. Повтор fixture(name) в одном rig возвращает прежний handle, не сбрасывает данные.

## documents

Пакет test.documents. Type Document: object {count:integer>=0}, required count, additionalProperties=false. Исходный object value {count:0}. Meta refs в source используют local; после install все ссылки full. Handle.definitions.Document ссылается на этот тип. Данные доступны только principal тестового rig в его scope. Установка не выполняет transport calls.

## composite

Пакет test.composite. Корень Root реализует Echo:run, имеет обязательный single slot body (min=max=1) и optional single slot other (min=0,max=1). Обе принимают точный Echo ContractRef. assembly.instances[0] — Root, [1] — Child. Один binding Root.body→Child. Child имеет тот же Echo; IncompatibleChild имеет OtherEcho с идентичными input/output схемами, но другим name. Handle.definitions.IncompatibleChild — полная ссылка на его Implementation. Все config/state валидны, поэтому тесты не должны получать постороннюю ошибку раньше проверяемой.

## writer

Пакет test.writer. Операция write принимает {text:string}, defaults отсутствуют, output {externalId:string}. request.input={text:"hello"}; idempotencyKey="write-1". Реализация создаёт один effect внешней записи, retry strategy non-retryable, maxAttempts=1. После полного receipt возвращает output. Fake remote — отдельный процесс с собственной durable SQLite/JSON БД, которая не удаляется при crash host. Каждый реальный запрос повышает C; каждая созданная запись повышает S. effectCounts читает remote API, а не локальные counters адаптера.

crashAt ставит одноразовый barrier в продукте. pump ждёт отсутствия runnable work И завершения всех unheld fake effects вместе с обработкой их durable receipts. Обычное ожидание сетевого Promise не завершает pump. Ранний возврат допускается только при crash hook, явно установленном held barrier, waiting/input или waiting/indeterminate. Для normal writer pump возвращается после succeeded/failed; timeout — ошибка теста, не успешный idle. Crash не маскирует неожиданное исключение. recover поднимает новый процесс на той же БД и с новым runnerEpoch; fake remote продолжает работать. В after_remote_accept_before_receipt remote запись уже committed, host receipt ещё отсутствует. В after_receipt_commit_before_reduce receipt/inbox уже durable. Нельзя эмулировать crash обычным выбрасыванием исключения с graceful cleanup.

## budget-tree

Пакет test.budget-tree. Root имеет двух children с held fake effects. Budget unit=test-credit. Верхняя граница каждой попытки передаётся reservations массива. runBudgetRace только вызывает реальные child operations одновременно и держит remote completions на barrier; не вычисляет бюджет самостоятельно. Инспекция ledger производится через runtime API. Для runtime.feature nested variant добавляется grandchild; ни один посредник не создаёт отдельную денежную запись.

## agent

Fake LLM выдаёт заранее записанную последовательность полных ответов или chunk/final events. Fixtures: toolThenAnswer; rejectThenAccept; missingFinal; truncatedToolJson; changedCandidateAfterAcceptance. Контекст, tool schemas и verifier inputs сохраняются для проверки. Счётчик ModelCall повышается только fake provider transport. Проверки памяти отличают provisional наблюдения от accepted knowledge.

## checklist и badge

test.checklist определяет новый Type Checklist {title:string,items:[{id:string,done:boolean}]}, completeItem operation с CAS, свой namespace и View с ordered slot item.badges. test.badge реализует точный контракт этого slot и показывает computed doneCount; не меняет Checklist. Пакеты устанавливаются без редактирования host/web-shell исходников. UI fixture данных и сценарии перечислены в ui.feature.

## Детерминизм тестов

Clock начинается 2026-01-01T00:00:00Z и продвигается только явной командой теста. Идентификаторы предоставляет записываемый deterministic ID source. Никаких sleep для race assertions: используются barriers до/после commit. Отдельный временный каталог/порт на тест. Product crash и remote crash — разные действия. Cleanup закрывает свои процессы по PID/handle, не использует широкие pkill.
