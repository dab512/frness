# FRNESS

Фрактально расширяемый агентский харнес. Типы объектов, операции, хранение, агентское исполнение и интерфейс определяются плагинами через общую метамодель. Плагины могут объявлять собственные типизированные слоты для других плагинов.

## Спецификация и реализация

В репозитории подготовлен проверенный пакет спецификаций. Реализация выполняется последовательно по его плану.

- [Начать с пакета спецификаций](specs/fractal-harness/README.md).
- [Архитектура](specs/fractal-harness/ARCHITECTURE.md) и [контракты](specs/fractal-harness/CONTRACTS.md).
- [План реализации](specs/fractal-harness/PLAN.md): 32 этапа с зависимостями, включая CLI agent backend.
- [Hot reload каждого плагина](specs/fractal-harness/HOT-RELOAD.md).
- [Инструкция исполнителю](specs/fractal-harness/HANDOFF.md).
- [Поэтапная приёмка](specs/fractal-harness/atomic-gates.json) и [полная тестовая матрица](specs/fractal-harness/TESTING.md).

## Проверить спецификацию

Требуется Node.js 24.

```sh
npm ci --prefix specs/fractal-harness
npm run check --prefix specs/fractal-harness
```

Проверяются TypeScript-контракты, Gherkin, ссылки, тестовые идентификаторы и зависимости этапов. Приёмочные тесты продукта требуют его реализации и отдельного адаптера; отсутствие адаптера завершается явной ошибкой.

## Работа над реализацией

[Локальный daemon/API/CLI и проверенные сценарии](docs/local-development.md).

```sh
npm ci
npm run verify -- --atom FH-00
```

Каждый этап имеет свой тест и проверяется вместе с lint, typecheck, спецификацией и границами зависимостей. Отсутствующий тест или невыполненная зависимость дают ошибку. Фактический прогресс хранится в [implementation-status.json](implementation-status.json), свидетельства — в verification/.

```sh
npm run progress -- begin FH-01
npm run test:atom -- tests/atoms/FH-01.test.ts
npm run verify -- --atom FH-01
npm run progress -- done FH-01
```

Структура будущих модулей уже создана; наличие workspace не означает реализации его функций.

## Проверить загрузку метамодели

```sh
npm run boot:build -- .frness/demo-1
npm run boot:inspect -- .frness/demo-1
```

Сборка создаёт пять закреплённых пакетов: seed и четыре технических моста. Загрузчик проверяет все digest до импорта кода, разрешает локальные ссылки без изменения исходников и выполняет self-validation. Собирать нужно в новый пустой каталог: существующие артефакты не перезаписываются.
