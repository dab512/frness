# Проверка подготовленного пакета

Дата: 2026-10-14. Проверялся пакет спецификаций и тестов, а не реализация продукта.

## Фактически выполненные проверки

| Проверка | Результат |
| --- | --- |
| Установка закреплённых dev dependencies без install scripts | Успешно; package-lock.json сохранён. |
| TypeScript strict/noEmit для contracts.ts, standard-contracts.ts, acceptance-api.ts | Exit 0. |
| check-spec: локальные ссылки документов | Все проверенные цели существуют. |
| check-spec: DAG реализации | 30 атомов; неизвестных зависимостей и циклов нет. |
| check-spec: отдельные AT gates | 30 уникальных проверок с given/when/then, по одной на атом. |
| check-spec: traceability | 97 полных тестовых групп назначены атомам; неизвестных IDs нет. |
| Официальный Gherkin parser | 67 Scenario/Scenario Outline, 120 случаев с учётом Examples; синтаксис корректен. |
| node --check для acceptance.test.mjs и check-spec.mjs | Exit 0. |
| Исполняемый black-box набор без SUT | Ожидаемый exit 1 с IMPLEMENTATION_MISSING; ноль skipped. |
| Межфайловой аудит контрактов | Устранены конфликты ссылок/digest, DTO, idempotency scope, UI slots, init state, repository calls и per-atom gates. |

## Что подготовлено, но ещё не прошло приёмку продукта

14 исполняемых black-box тестов готовы к подключению через acceptance-api.ts. У продукта ещё нет реализации/адаптера, поэтому ни один из них не объявлен пройденным. Gherkin задаёт конкретные оракулы для будущих contract/integration/e2e tests; его успешный parsing не подтверждает поведение системы.

Локальный dev, реальные restart/crash проверки, браузерные сценарии и живой LLM-вызов включены в обязательный план. Их выполнение относится к реализации, а не к подготовке этого пакета.

## Повторить проверку спецификации

    npm ci
    npm run check

Рабочая директория — каталог этого файла. Для будущей приёмки:

    FRACTAL_SUT_MODULE=/absolute/path/to/acceptance-adapter/dist/index.js npm run test:acceptance

Системный npm cache в текущем окружении был недоступен на запись; для установки использовался отдельный cache во временном каталоге. Пользовательский cache и его права не менялись.
