import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { type ElectronApplication, _electron as electron } from "playwright";

async function launch(workspace: string, executable: string) {
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    FRNESS_NODE: process.execPath,
    FRNESS_WORKSPACE: workspace,
    FRNESS_AGENT_EXECUTABLE: executable,
    FRNESS_DESKTOP_DATA: join(workspace, "electron-data"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_TEST_CONTEXT;
  return electron.launch({ args: [resolve("apps/web/desktop/main.mjs")], env, timeout: 30_000 });
}
async function waitPhase(app: ElectronApplication, phase: string) {
  const page = await app.firstWindow();
  await page.waitForFunction(
    (expected) => document.getElementById("status")?.textContent === expected,
    phase,
  );
  return page;
}
test("Electron runs FRNESS, continues sessions, renders inert text and survives a closed window", {
  timeout: 60_000,
}, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "frness-electron-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const app = await launch(workspace, resolve("tests/fixtures/agent-runner/codex"));
  t.after(() => app.close());
  let page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector("#workspace");
  await page.waitForFunction(() =>
    document.getElementById("workspace")?.textContent?.includes("frness-electron-"),
  );
  assert.equal(
    await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require),
    "undefined",
  );
  const prompt = "<img src=x onerror=alert(1)> Привет 🌲";
  await page.locator("#prompt").fill(prompt);
  await page.locator("#send").click();
  await waitPhase(app, "Завершено");
  assert.equal(await page.locator(".message.agent pre").last().textContent(), prompt);
  assert.equal(await page.locator("#messages img").count(), 0);
  const first = JSON.parse(
    await readFile(join(workspace, ".frness/selfhost/last-run.json"), "utf8"),
  );
  await page.locator("#prompt").fill("Продолжи");
  await page.locator("#send").click();
  await waitPhase(app, "Завершено");
  const second = JSON.parse(
    await readFile(join(workspace, ".frness/selfhost/last-run.json"), "utf8"),
  );
  assert.deepEqual(first.session, second.session);
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/desktop.png" });
  await page.locator("#prompt").fill("hold");
  await page.locator("#send").click();
  await waitPhase(app, "Агент работает");
  assert.equal(await page.locator("#provider").isDisabled(), true);
  let ready = false;
  for (let attempt = 0; attempt < 100 && !ready; attempt++) {
    const db = new Database(join(workspace, ".frness/selfhost/data/cli.sqlite"), {
      readonly: true,
    });
    try {
      ready =
        (
          db
            .prepare(
              "SELECT count(*) n FROM revisions WHERE object_id LIKE 'Event/%' AND json_extract(value, '$.event.value.type') = 'test.ready'",
            )
            .get() as { n: number }
        ).n > 0;
    } finally {
      db.close();
    }
    if (!ready) await setTimeout(50);
  }
  assert.ok(ready, "CLI process must be running before closing the window");

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible()),
    false,
  );
  await app.evaluate(({ app }) => app.emit("activate"));
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible()),
    true,
  );
  await page.waitForSelector("#stop:visible");
  await page.locator("#stop").click();
  await waitPhase(app, "Остановлено");
  assert.equal(await page.locator(".message.user").count(), 3);
  assert.deepEqual(errors, []);
  await page.locator("#new").click();
  await page.waitForSelector("#empty:visible");
  await page.locator("#prompt").fill("hold");
  await page.locator("#send").click();
  await page.locator("#stop").click();
  await waitPhase(app, "Остановлено");
});
test("Electron surfaces an unavailable CLI and allows a new request", {
  timeout: 30_000,
}, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "frness-electron-error-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const app = await launch(workspace, "/missing/frness-cli");
  t.after(() => app.close());
  const page = await app.firstWindow();
  await page.locator("#prompt").fill("hello");
  await page.locator("#send").click();
  await page.waitForFunction(() =>
    ["Ошибка агента", "Результат неизвестен. Проверьте состояние перед повтором"].includes(
      document.getElementById("status")?.textContent ?? "",
    ),
  );
  assert.equal(await page.locator("#send").isEnabled(), true);
});

test("Electron installs and reloads plugin generations, preserving prior generation on failure", {
  timeout: 60_000,
}, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "frness-electron-plugins-"));
  const id = `desktop-${Date.now()}`;
  const directory = resolve("extensions", id);
  t.after(() => rm(workspace, { recursive: true, force: true }));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await promisify(execFile)(process.execPath, [
    "--import",
    "tsx",
    "apps/cli/src/plugins.ts",
    "scaffold",
    id,
  ]);
  const app = await launch(workspace, resolve("tests/fixtures/agent-runner/codex"));
  t.after(() => app.close());
  const page = await app.firstWindow();
  await page.waitForFunction(
    () => document.getElementById("status")?.textContent === "Плагины готовы",
  );
  assert.equal(await page.locator("#mode").inputValue(), "default");
  await page.selectOption("#mode", "workspace");
  assert.match((await page.locator("#mode-description").textContent()) ?? "", /workspace-write/);
  await app.evaluate(
    ({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    },
    join(directory, "extension.ts"),
  );
  await page.locator("#plugin").click();
  await page.waitForFunction(() =>
    Boolean(document.getElementById("plugin-status")?.textContent?.startsWith("Сборка")),
  );
  await page.waitForFunction(
    () => document.getElementById("status")?.textContent === "Плагины готовы",
  );
  await page.locator("#prompt").fill("with-plugin");
  await page.locator("#send").click();
  await waitPhase(app, "Завершено");
  assert.equal(await page.locator("#mode").inputValue(), "default");
  const activePath = join(workspace, ".frness/plugins/active.json");
  const first = await readFile(activePath, "utf8");
  const source = join(directory, "extension.ts");
  await writeFile(
    source,
    (await readFile(source, "utf8")).replace(`label: "${id}"`, 'label: "updated"'),
  );
  await page.locator("#reload").click();
  await page.waitForFunction(
    () => document.getElementById("status")?.textContent === "Плагины готовы",
  );
  assert.notEqual(await readFile(activePath, "utf8"), first);
  await page.locator("#prompt").fill("reloaded");
  await page.locator("#send").click();
  await waitPhase(app, "Завершено");
  const db = new Database(join(workspace, `.frness/selfhost/data/${id}.sqlite`), {
    readonly: true,
  });
  try {
    assert.deepEqual(
      (
        db.prepare("SELECT value FROM revisions WHERE object_id LIKE 'Note/%'").all() as {
          value: string;
        }[]
      )
        .map((x) => JSON.parse(x.value).label)
        .sort(),
      [id, "updated"].sort(),
    );
  } finally {
    db.close();
  }
  const second = await readFile(activePath, "utf8");
  await writeFile(source, "invalid !!!");
  await page.locator("#reload").click();
  await page.waitForFunction(() =>
    document.getElementById("status")?.textContent?.startsWith("Плагин не подключён"),
  );
  assert.equal(await readFile(activePath, "utf8"), second);
  await page.locator("#prompt").fill("after-error");
  await page.locator("#send").click();
  await waitPhase(app, "Завершено");
});
