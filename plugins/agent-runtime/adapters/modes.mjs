// Provider-owned UI metadata; execution validates the same ids before spawning.
export const providerModes = {
  codex: [
    {
      id: "default",
      label: "Штатные разрешения Codex",
      description:
        "Настройки CLI. В print/exec режиме интерактивные запросы подтверждений не обслуживаются.",
    },
    {
      id: "workspace",
      label: "Самостоятельно в рабочей папке",
      description:
        "Команды и правки без отдельных подтверждений. Sandbox workspace-write сохранён. Только для этого запуска.",
    },
  ],
  claude: [
    {
      id: "default",
      label: "Штатные разрешения Claude",
      description:
        "Используется текущая политика CLI. Интерактивные запросы не обслуживаются этим transport.",
    },
  ],
};
