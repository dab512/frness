# Bootstrap: конечная загрузка метамодели и стандартных мостов

Статус: нормативная спецификация, реализация ещё не проверена. Этот документ закрывает начальную загрузку; он не добавляет второй framework исполнения. Формы runtime-объектов определяет [contracts.ts](./contracts.ts), их семантику — [CONTRACTS.md](./CONTRACTS.md).

## 1. Неизменная граница

Host понимает только bootstrap manifest, JSON, точные ссылки, загрузку проверенного ESM export, регистрацию технического валидатора/ABI adapter и capability handles. Он не знает `Request`, `Invocation`, `Session`, статусы исполнения или предметные операции.

`boot-lock.json` — доверенный исходный lock поставки приложения. Обычный плагин не может его произвольно изменить. Lifecycle reload публикует новый проверенный generation lock через технический supervisor по HOT-RELOAD.md; совместимые seed/bridge пакеты с тем же hostAbi обновляются без restart. Изменение низкоуровневого hostAbi требует новой поставки процесса. Active generation lock и исходный boot-lock различаются; crash recovery читает подтверждённый active pointer и pinned locks старых исполнений.

Bootstrap не скачивает пакеты, схемы, зависимости или код. Все артефакты уже находятся локально. ESM bundles стандартных мостов не имеют побочных действий на уровне module import. Их activation регистрирует технические обработчики и не запускает LLM, инструменты, таймеры или предметные операции.

Доверенные TypeScript-плагины работают в общем процессе. Эти требования проверяются тестами и правилами зависимостей; они не являются sandbox для злонамеренного Node-кода.

## 2. Точный формат boot-lock.json

```ts
interface BootLock {
  readonly format: 1;
  readonly hostAbi: "fractal.host.v1";
  readonly packages: readonly {
    readonly artifactPath: string;
    readonly digest: string;
  }[];
  readonly activations: readonly {
    readonly packageDigest: string;
    readonly exportName: string;
  }[];
}
```

Все перечисленные поля обязательны; дополнительные поля запрещены на каждом уровне. `packages` и `activations` непустые. Порядок обоих массивов значим и сохраняется. `digest`/`packageDigest` имеют форму `sha256:` и ровно 64 lowercase hexadecimal символа. `exportName` — ключ `PackageManifest.exports`, а не непосредственно имя JavaScript export.

`artifactPath` — относительный POSIX-путь от каталога boot-lock. Пустой путь, абсолютный путь, сегменты `.`/`..`, обратный слеш, пустой сегмент и symlink отклоняются. Разрешённый путь после проверки находится внутри каталога поставки. Package loader не следует symlink ни в пути артефакта, ни внутри него.

Один путь и один digest встречаются в `packages` не более одного раза. Каждая activation ссылается на пакет из этого массива. Пара `(packageDigest, exportName)` уникальна. Все заявленные зависимости присутствуют в lock; после чтения manifests проверяется, что зависимости других пакетов расположены раньше зависимого пакета. Ссылки между определениями внутри одного пакета могут быть циклическими и не образуют цикл загрузки пакетов.

Digest считается по исходным байтам по C02. `boot-lock.json` находится вне package artifact и не участвует в package digest. Поле собственного digest в package manifest отсутствует. Файл `package.digest`, если присутствует, является проверяемой копией вычисленного значения и единственным исключённым из package hash файлом.

## 3. Источники ссылок и отсутствие self-hash

В исходном manifest допустимы две формы ссылки:

```ts
type SourceDefinitionRef = DefinitionRef | { readonly local: string };
```

Полная ссылка содержит ровно `packageId`, `packageVersion`, `digest`, `name`. Локальная ссылка содержит только `local`; её значение имеет ограничения `DefinitionRecord.name`. Локальная ссылка разрешается в определение того же пакета. Межпакетные ссылки всегда полные. `PackageManifest.dependencies` содержит только внешние полные ссылки.

Для каждого пакета сначала вычисляется digest неизменённых исходных файлов. Затем `{local: name}` заменяется в отдельной resolved projection на `{packageId, packageVersion, digest, name}`. Исходные файлы не переписываются; resolved projection никогда не является входом вычисления package digest. Кеш projection адресуется исходным digest и версией resolver.

Разрешение ссылок производится только:

1. В `SourceDefinitionRecord.metaType`.
2. В позициях значения определения, чья метасхема помечает значение аннотацией `x-definition-ref: true`.
3. В известной позиции manifest.reload.snapshotType; остальные reload metadata не преобразуются как ссылки.

Resolver не ищет произвольные объекты с ключом `local` по всему JSON. Содержимое `TypeDefinition.schema` — данные схемы, а не автоматически обрабатываемый payload этой схемы. Например, literal `default: {local: "example"}` внутри схемы не преобразуется.

Аннотация означает: данное значение целиком является ссылкой. Для source validation в этой позиции допускается full-or-local; для resolved validation — только полный `DefinitionRef`. Остальные ограничения схемы остаются прежними. Для массива аннотация ставится в `items`, для map — в схеме `additionalProperties`. Неизвестное локальное имя отклоняется, без поиска одноимённого определения в другом пакете.

## 4. Точный состав seed-пакета

Первым пакетом поставляется `std.meta`. Его определения называются ровно `Type`, `Contract`, `Implementation`, `Slot`, `Instance`, `Binding`, `Assembly`, `ConformanceSuite`. Каждое из восьми определений — `SourceDefinitionRecord`, у которого `metaType = {local: "Type"}`, а `value` имеет форму `TypeDefinition {schema, references}`. Поэтому определение `Type` также описано типом `Type`.

Встроенный конечный bootstrap-validator проверяет source manifest, форму восьми TypeDefinition и перечисленные ниже ограничения. Полные схемы хранятся как JSON-данные в seed; host не получает восемь отдельных предметных классов или обработчиков. После загрузки meta-validator повторно проверяет эти же определения своим обычным публичным API.

Общие ограничения схем:

- Все object-схемы фиксированной формы имеют `additionalProperties: false` и явный `required`.
- Все массивы имеют явную схему `items`; все map имеют явную схему `additionalProperties`.
- `Json` означает допустимые значения и ограничения C01. Сохраняемые функции, undefined, Date и другие не-JSON значения запрещены.
- `Id` и `Revision` — непустые строки; ревизии сравниваются только на равенство.
- Неотрицательные целые значения ограничены `Number.MAX_SAFE_INTEGER`.
- `DefinitionRef` имеет четыре обязательных поля и ограничения C02. Для ожидаемой категории ссылки validator проверяет не только форму ссылки, но и метатип адресуемого определения.
- `schema` — JSON Schema draft 2020-12. `references` — map разрешённых ссылок на определения с метатипом `Type`; сеть при компиляции схем запрещена.

| Seed definition | Форма `value`, которую описывает его `schema` | Required | Помеченные reference-позиции |
| --- | --- | --- | --- |
| `Type` | `TypeDefinition` из contracts.ts: `schema: JsonSchema`, `references: map<TypeRef>` | `schema`, `references` | `references.*` |
| `Contract` | `operations: map<OperationDefinition>`, `conformanceSuite: DefinitionRef`, `allowedEffects: ContractRef[]` | все три поля | `operations.*.input`, `operations.*.output`, `conformanceSuite`, `allowedEffects[*]` |
| `Implementation` | `contracts: ContractRef[]`, `configurationType: TypeRef`, `stateType: TypeRef`, `slots: SlotDefinition[]`, `entry: string`, `abi: string`, `requiredCapabilities: string[]` | все семь полей | `contracts[*]`, `configurationType`, `stateType`, `slots[*].accepts` |
| `Slot` | `name: string`, `accepts: ContractRef`, `collection: single\|ordered\|keyed`, `min: integer`, `max: integer` | все пять полей | `accepts` |
| `Instance` | `ComponentInstance`: `instanceId: Id`, `implementation: ImplementationRef`, `configuration: Json`, `stateNamespaceId: Id`, `scopeId: Id` | все пять полей | `implementation` |
| `Binding` | `parentInstanceId: Id`, `slot: string`, `childInstanceId: Id`, optional `order: integer`, optional `key: string` | первые три поля | нет |
| `Assembly` | `assemblyId: Id`, `revision: Revision`, `rootInstanceId: Id`, `profile: volatile.v1\|durable.v1`, `instances: ComponentInstance[]`, `bindings: Binding[]` | все шесть полей | `instances[*].implementation` |
| `ConformanceSuite` | `entry: string`, `targetContract: ContractRef` | оба поля | `targetContract` |

Вложенная `OperationDefinition` содержит ровно `input: TypeRef`, `output: TypeRef`, `errorCodes: string[]`; все поля обязательны. Вложенные Slot/Instance/Binding соответствуют тем же схемам, что отдельные определения. Для `operations` ключи имеют ограничения имени операции; пустой map запрещён. Массивы контрактов, capability names и error codes не содержат повторов. Пустой `contracts` допустим только у технической реализации, не подключаемой в contract slot; linker не выводит совместимость из ABI.

`min/max`, key/order и целостность дерева дополнительно проверяются linker по C04. Эти межобъектные проверки не имитируются одной JSON Schema. `conformanceSuite` указывает на определение метатипа `ConformanceSuite`; его `targetContract` должен указывать обратно на проверяемый контракт. `entry` этого suite — server export своего пакета. Bootstrap проверяет ссылку и export, но не запускает conformance suite с внешними действиями.

Форма `stateType` в Implementation не означает общего mutable state для всех вызовов. Для `reducer.v1` это тип состояния одного Invocation. Постоянные данные экземпляра доступны отдельно через store operations и `stateNamespaceId`.

### Разрешение JSON Schema references

Локальные JSON Schema `$ref` вида `#/$defs/...` остаются локальными ссылками схемы. Межтиповая ссылка задаётся `$ref: "type:ALIAS"`, где `ALIAS` — непустой ключ `TypeDefinition.references`. Compiler разрешает alias в точный TypeRef и регистрирует схему с внутренним ID, производным от полной ссылки. Иные внешние URI запрещены; `compileAsync` со скачиванием схем не используется.

Таблица source reference-позиций выше является конечной bootstrap-копией аннотаций seed. На втором проходе validator проверяет её совпадение с `x-definition-ref` в схемах seed. Обычные пакеты используют аннотации зарегистрированных метасхем и не расширяют эту встроенную таблицу.

## 5. Стандартные мосты и их exports

Следующий список является составом первой поставки. Версии и digest конкретной сборки фиксируются boot-lock, без строк-заглушек и разрешения `latest` во время старта.

| Пакет | Manifest export key | Environment | Регистрация |
| --- | --- | --- | --- |
| `std.meta` | `activateMeta` | server | validator `meta.v1`, разрешение метаописаний и проверка типов |
| `std.bridge.store` | `activateStore` | server | ABI `store.v1` |
| `std.bridge.reducer` | `activateReducer` | server | ABI `reducer.v1` |
| `std.bridge.effect` | `activateEffectAdapter` | server | ABI `effect-adapter.v1` |
| `std.bridge.react` | `activateReactDescriptor` | server | декларативная проверка client ABI `react-view.v1`, без импорта React |
| `std.bridge.react` | `activateReactView` | client | client adapter `react-view.v1`, использующий host-provided React |

Bridge package предоставляет форму загрузки и проверки соответствующего экспорта. Реальная SQLite-реализация, LLM adapter, reducer агента и конкретный React renderer являются отдельными Implementation definitions. Установка bridge сама по себе их не создаёт и не вызывает.

Реестр ABI разделён по environment. Серверный react descriptor проверяет метаданные и доступность client export; он не рендерит компонент. Browser shell получает уже проверенные definitions и bundles от локального сервера, исполняет только client activations и не импортирует Node-код. В browser документе один экземпляр React через закреплённый import map.

Неизвестный ABI, повторная регистрация занятых validator/ABI ID в одной generation либо попытка изменить существующий adapter in-place отклоняются. Candidate generation получает отдельный registry; те же ABI IDs там разрешены при compatible hostAbi. Не-bootstrap пакет не получает registration capability, даже если объявляет export с именем `activateMeta`.

## 6. Технический activation ABI

```ts
type Cleanup = () => void | Promise<void>;
type Activate = (host: BootstrapRegistrationHost) => Cleanup | Promise<Cleanup>;
```

`BootstrapRegistrationHost` — ограниченный технический handle. Он позволяет зарегистрировать generic validator/ABI adapter в текущем candidate registry и получить разрешённые зависимости bootstrap. Он не предоставляет invoke, repository предметных объектов, секреты, сетевой клиент или возможность изменить boot-lock. Конкретный adapter handle интерпретирует стандартный bridge; host не добавляет switch по имени ABI.

Только точная пара из `BootLock.activations` получает этот handle. Manifest export key разрешается в `path + exportName + environment`; загружается только проверенный artifact path. Activation вызывается не более одного раза для одной пары в рамках попытки boot. Вернувшийся cleanup обязателен. Все регистрации activation записываются в её технический scope; при rollback host удаляет их независимо от успешности cleanup.

Cleanup вызывается в обратном порядке успешных activations. Ошибка одного cleanup сохраняется как дополнительная диагностика, но не прерывает очистку остальных и не заменяет исходную ошибку boot. Обычная остановка приложения также освобождает activations в обратном порядке.

## 7. Два прохода и атомарная публикация

Техническая инициализация мостов внутри закрытого candidate registry отличается от публичной активации новой поставки. До завершения обоих проходов никакие клиенты или обычные плагины не видят candidate и не могут отправлять ему предметные вызовы.

### Проход 1 — конечная проверка и подготовка

1. Прочитать boot-lock как JSON; проверить форму и ограничения путей до filesystem traversal. Проверить наличие всех указанных локальных артефактов.
2. Вычислить digest всех файлов каждого артефакта; сравнить с lock. Не импортировать ESM до окончания проверки всех package digests.
3. Проверить manifests конечной bootstrap-схемой, уникальность `(packageId, version)`, declarations/exports и порядок внешних dependencies. Проверить, что все activations существуют и имеют допустимый environment.
4. Построить source symbol table всех definition names. Проверить восемь seed-схем и конечные bootstrap reference-позиции. Вычислить resolved projection seed с полными ссылками; разрешить остальные определения по их уже известным метасхемам. Допустимые forward refs внутри пакета разрешаются через symbol table, без вызова кода.
5. Создать пустой candidate registry. Запустить только allowlisted activations текущего environment в порядке lock. Их регистрации остаются закрытыми. Серверная descriptor-регистрация client ABI не исполняет client bundle.

### Проход 2 — обычная проверка через метамодель

6. Зарегистрированный `meta.v1` проверяет resolved seed обычным API. Каждое из восьми определений валидируется по `meta.Type`; затем проверяются описанные ими определения и ожидаемые категории refs. Сверить marker positions с bootstrap-копией.
7. Тем же API проверить все остальные resolved definitions, references, environments, объявленные ABI и export descriptors. Проверить выбранную начальную Assembly linker-ом. Проверка export descriptor не выполняет reducer, effect или React render.
8. При успехе атомарно опубликовать candidate registry как активный registry процесса. Только теперь стандартный execution-плагин может принимать вызовы, store-реализация — открывать рабочий namespace, а web shell — публиковать доступные клиентские расширения.
9. При любой ошибке выполнить cleanup и отбросить candidate. На первом старте приложение остаётся неготовым. При staged install прежние registry/assembly/data не меняются. Повтор начинается с нового candidate; частично активных пакетов не остаётся.

Browser выполняет отдельную candidate activation только client exports уже проверенной сервером поставки. Атомарность относится к registry каждого процесса; распределённая атомарная транзакция между браузером и сервером не обещается. UI не переключается на новый registry до успешной проверки его client activation; серверные данные от ошибки браузерного renderer не меняются.

## 8. Семантика мостов, обязательная для загрузки

- `reducer.v1` загружает объект с чистыми функциями `initialize(input, config) -> state` и `reduce(state, event, config) -> {state, commands}`. Promise, I/O и неконтролируемые clock/random запрещены. Initialize создаёт состояние отдельного Invocation после проверки input/config; результат проверяется по stateType. После сохранения состояния resume не запускает initialize заново. Если процесс упал до commit, чистая initialize может быть вычислена повторно с тем же входом.
- `effect-adapter.v1` загружает execute/reconcile реализацию по точному контракту эффекта. Вызов адресует подключённый adapter instance со своей закреплённой configuration и capability bindings, а не произвольный ImplementationRef. Сам bridge не отправляет запросы во время bootstrap.
- `store.v1` проверяет контракт store adapter. Atomic storage profile и реальные транзакционные гарантии проверяются storage conformance suite. Имя ABI не доказывает, что backend поддерживает durable profile.
- Дополнительный `factory.v1` регистрируется api-пакетом для серверных сервисов. Export содержит create(FactoryContext) → NativeService; контекст выдаёт pinned instance, registry, связанные children и явно выданные capabilities. NativeService имеет value и dispose. HTTP, storage и backend описаны обычными Implementation/Contract/Slot records и собираются из service assembly. Host хранит только проверенные server exports по digest/entry; клиентский код через этот интерфейс недоступен. Этот ABI не добавляет доменных сущностей в host.
- `react-view.v1` загружает client renderer и передаёт ограниченный view context. Слоты принадлежат только ImplementationDefinition. ViewDefinition содержит `targetType`, `propsType`, `implementation`; ViewMount связывает `viewInstanceId` и `assemblyRevision`. Renderer разрешает дочерние слоты через обычные bindings закреплённой UI assembly; bootstrap не знает имён slot.

Изменение декларации ABI в данных не меняет эти правила. Новый технический ABI требует нового allowlisted bridge и проверенного candidate lock; при прежнем hostAbi он может активироваться hot reload. Новый предметный тип, операция, слот или renderer при существующем ABI не требует изменения host.

## 9. Детерминированный приоритет ошибок

Проверки исполняются этапами в указанном порядке. Более поздний этап не исполняется после ошибки более раннего. Внутри этапа выбирается первая ошибка по порядку `packages`, затем `definitions` в manifest; дополнительные diagnostics можно вернуть отдельно. При ошибке не выполняются предметные операции.

| Этап | Условие | Основной код |
| --- | --- | --- |
| 1 | Boot-lock или указанный локальный artifact отсутствует | `BOOTSTRAP_PACKAGE_MISSING` |
| 1 | Невалидный lock/JSON/путь/дубликат activation | `INVALID_INPUT` |
| 2 | Байты артефакта не совпали с lock | `DIGEST_MISMATCH` |
| 3 | Одинаковый package ID/version с разным содержимым или повтор definition name | `DEFINITION_CONFLICT` |
| 3–4 | Нет exact dependency/local definition/внешней ссылки | `PINNED_DEPENDENCY_MISSING` |
| 3–4 | Невалидная source schema/manifest/reference marker | `INVALID_INPUT` |
| 5 | Activation отсутствует в allowlist или запрашивает невыданную возможность | `CAPABILITY_DENIED` |
| 5 | Activation пытается занять уже зарегистрированный validator/ABI ID | `DEFINITION_CONFLICT` |
| 5 | Allowlisted activation выбросила исключение | `DEPENDENCY_UNAVAILABLE` |
| 6–7 | Невалидное resolved определение/метатип/схема | `INVALID_INPUT` |
| 7 | ABI не зарегистрирован для нужного environment | `UNKNOWN_ABI` |
| 7 | Export не имеет объявленной ABI-формы | `INVALID_OUTPUT` |
| 7 | Невалидная композиция | соответствующий linker error из C11 |

Например, пакет с неверным digest и некорректной схемой возвращает `DIGEST_MISMATCH`, а счётчик module imports остаётся нулём. Dependency missing обнаруживается до activation, поэтому не заменяется ошибкой при импорте модуля.

## 10. Обязательные тесты

### Выдача capabilities нативным экспортам

`FactoryContext.exported(implementation, instanceId?)` возвращает закреплённый export. Без instanceId действует прежний путь для чистых модулей. С instanceId daemon проверяет точное соответствие ImplementationRef экземпляру из application assembly и его собственные grants. Export может дополнительно объявить `bindCapabilities({registry, capability})`; результат обязан удовлетворять исходному ABI. Binder получает capabilities только этого instance. Выданные credential getters проверяют binding→instances при каждом обращении; секреты не входят в configuration, journal или snapshot. Это необязательный технический decorator, не новый предметный ABI.

Binder не выполняет внешний запрос. Повторные execute/reconcile используют один bound export на instance и pinned implementation. Полученный export не заменяет опубликованные module exports и не меняет другие instances.

| ID | Подготовка и действие | Точный оракул |
| --- | --- | --- |
| `META-001` | Загрузить минимальный seed из восьми определений, затем проверить их публичным meta-validator | Все восемь имеют resolved metaType `std.meta.Type`; self-validation проходит; в registry нет source local refs; неизвестные предметные типы не встроены в host |
| `META-002` | В одном пакете Contract и ConformanceSuite ссылаются друг на друга через local; в произвольном schema default есть `{local:"literal"}` | Пакет хешируется один раз по raw bytes; обе ссылки разрешены в один вычисленный digest; literal не изменён; raw files побайтно прежние; повторный build даёт тот же digest |
| `BOOT-001` | Отсутствует lock либо один artifact | `BOOTSTRAP_PACKAGE_MISSING`; imports=0; active registry не изменён |
| `BOOT-002` | Один artifact имеет неверный digest и неверную schema | `DIGEST_MISMATCH`; imports=0; schema validator не вызван |
| `BOOT-003` | Path traversal или symlink ведёт за пределы поставки | `INVALID_INPUT` до чтения target; никаких импортов |
| `BOOT-004` | Полная dependency отсутствует либо local ref не существует | `PINNED_DEPENDENCY_MISSING`; activations=0; registry не публикуется |
| `BOOT-005` | Runtime-плагин пытается зарегистрировать новый ABI | `CAPABILITY_DENIED`; действующий ABI registry неизменён |
| `BOOT-006` | Третья activation бросает исключение после двух успешных | Cleanup второй и первой вызван в обратном порядке; candidate registrations удалены; старый registry работает; исходная ошибка сохранена |
| `BOOT-007` | Второй self-validation проход обнаруживает несовпадающую seed marker table | `INVALID_INPUT`; candidate не опубликован; очищены все успешные activations |
| `BOOT-008` | Известный implementation ссылается на неизвестный ABI | `UNKNOWN_ABI`; implementation export не вызывается |
| `BOOT-009` | Server boot включает react descriptor и client activation в lock | Сервер не импортирует client bundle/React; browser не импортирует Node bundle; каждый registry получает только соответствующие adapters |
| `BOOT-010` | Повтор пакета с тем же ID/version и другим digest | `DEFINITION_CONFLICT`; прежнее определение не заменено |
| `BOOT-011` | Два Invocation одного reducer instance; один затем восстанавливается | У них независимые initialize state; persistent component data доступны только через store; resume использует сохранённый state |
| `BOOT-012` | Два UI mounts используют один target, но разные mount IDs | Каждый разрешает слоты по своему view instance/assembly; unmount одного освобождает только его ресурсы; target и второе представление сохраняются |

Тестовые counters/import hooks проверяют наблюдаемую механику загрузки. Они не заменяют проверки registry и сохранённых данных. Ни один bootstrap test не требует живого LLM, сетевого API или пользовательского credential.
