const $ = (id) => document.getElementById(id);
let busy = false;
function render(state) {
  busy = state.busy;
  $("workspace").textContent = state.workspace;
  $("workspace").title = state.workspace;
  for (const id of ["workspace", "provider", "new", "send"]) $(id).disabled = busy;
  $("stop").hidden = !busy;
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
$("workspace").onclick = () => window.frness.workspace().catch(error);
$("new").onclick = () => window.frness.newSession().catch(error);
$("stop").onclick = () => window.frness.stop().catch(error);
$("composer").onsubmit = async (event) => {
  event.preventDefault();
  if (busy || !$("prompt").value.trim()) return;
  const prompt = $("prompt").value;
  try {
    await window.frness.run({ prompt, provider: $("provider").value });
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
