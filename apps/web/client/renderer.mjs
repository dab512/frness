const $ = (id) => document.getElementById(id);
let busy = false;
let modes = {};
function modeOptions() {
  const options = modes[$("provider").value] ?? [];
  $("mode").replaceChildren(
    ...options.map((mode) => {
      const option = document.createElement("option");
      option.value = mode.id;
      option.textContent = mode.label;
      return option;
    }),
  );
  modeDescription();
}
function modeDescription() {
  $("mode-description").textContent =
    (modes[$("provider").value] ?? []).find((mode) => mode.id === $("mode").value)?.description ??
    "";
}
function render(state) {
  if (!Object.keys(modes).length) {
    modes = state.providerModes ?? {};
    modeOptions();
  }
  busy = state.busy || state.pluginBusy;
  $("workspace").textContent = state.workspace;
  $("workspace").title = state.workspace;
  for (const id of ["workspace", "provider", "new", "send", "plugin", "reload", "mode"])
    $(id).disabled = busy;
  $("stop").hidden = !state.busy;
  $("reload").disabled = busy || !state.extension;
  $("plugin-status").textContent = state.pluginRevision
    ? `Сборка ${state.pluginRevision.slice(0, 8)}: ${state.extension}`
    : "Плагины не подключены";
  $("plugin-tree").textContent = state.assembly
    ? state.assembly.instances
        .map(
          (item) =>
            `${item.instanceId}: ${item.implementation.packageId}/${item.implementation.name}\n` +
            state.assembly.bindings
              .filter((binding) => binding.parentInstanceId === item.instanceId)
              .map(
                (binding) =>
                  `  ${binding.slot}${binding.key ? `[${binding.key}]` : ""} → ${binding.childInstanceId}`,
              )
              .join("\n"),
        )
        .join("\n")
    : "";
  $("status").textContent = state.phase;
  $("session").textContent = state.hasSession ? "Продолжение сессии" : "Новый диалог";
  $("empty").hidden = state.messages.length > 0;
  const fragment = document.createDocumentFragment();
  for (const message of state.messages) {
    const article = document.createElement("article");
    article.className = `message ${message.role}`;
    const label = document.createElement("strong");
    label.textContent = message.role === "user" ? "Вы" : "Агент";
    const text = document.createElement("pre");
    text.textContent = message.text || (busy ? "Работает…" : "Ответ не получен");
    article.append(label, text);
    fragment.append(article);
  }
  $("messages").replaceChildren(fragment);
}
function error(error) {
  $("status").textContent = error.message ?? "Запуск не удался";
}
$("provider").onchange = modeOptions;
$("mode").onchange = modeDescription;
$("plugin").onclick = () => window.frness.plugin().catch(error);
$("reload").onclick = () => window.frness.reload().catch(error);
$("workspace").onclick = () => window.frness.workspace().catch(error);
$("new").onclick = () => window.frness.newSession().catch(error);
$("stop").onclick = () => window.frness.stop().catch(error);
$("composer").onsubmit = async (event) => {
  event.preventDefault();
  if (busy || !$("prompt").value.trim()) return;
  const prompt = $("prompt").value;
  try {
    await window.frness.run({ prompt, provider: $("provider").value, mode: $("mode").value });
    $("mode").value = "default";
    modeDescription();
    $("prompt").value = "";
  } catch (reason) {
    error(reason);
  }
};
$("prompt").onkeydown = (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    $("composer").requestSubmit();
  }
};
window.frness.observe(render);
await window.frness.state().then(render).catch(error);
