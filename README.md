# FRNESS

Фрактально расширяемый агентский харнес. Типы объектов, операции, хранение, агентское исполнение и интерфейс определяются плагинами через общую метамодель. Плагины могут объявлять собственные типизированные слоты для других плагинов.

## Спецификация и реализация

В репозитории подготовлен проверенный пакет спецификаций. Реализация выполняется последовательно по его плану.

- [Начать с пакета спецификаций](specs/fractal-harness/README.md).
- [Архитектура](specs/fractal-harness/ARCHITECTURE.md) и [контракты](specs/fractal-harness/CONTRACTS.md).
- [План реализации](specs/fractal-harness/PLAN.md): 31 этап с зависимостями.
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
