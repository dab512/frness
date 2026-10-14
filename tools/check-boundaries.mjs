import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { failure, root } from "./project.mjs";

async function sources(directory) {
  const result = [];
  let entries;
  try {
    entries = await readdir(resolve(root, directory), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory() && !["node_modules", "dist"].includes(entry.name))
      result.push(...(await sources(path)));
    else if (entry.isFile() && /\.(?:ts|tsx|mjs|js)$/.test(entry.name)) result.push(path);
  }
  return result;
}
let checked = 0;
for (const file of [...(await sources("packages/host/src")), ...(await sources("plugins"))]) {
  const text = await readFile(resolve(root, file), "utf8");
  const imports = [...text.matchAll(/(?:from\s*|import\s*\()(["'])([^"']+)\1/g)].map(
    (match) => match[2],
  );
  if (file.startsWith("packages/host/")) {
    if (imports.some((name) => /(?:plugins\/|@frness\/(?!abi\b|host\b))/.test(name))) {
      throw failure("HOST_DOMAIN_DEPENDENCY", file);
    }
    if (
      /\b(?:session_id|project_id|request_id)\b|\b(?:Session|Project|Invocation)(?:Manager|Store|State)\b/.test(
        text,
      )
    ) {
      throw failure("HOST_DOMAIN_MODEL", file);
    }
  }
  if (
    file.includes("/server/") &&
    imports.some((name) => /^(?:react|react-native)(?:\/|$)|\/client\//.test(name))
  ) {
    throw failure("SERVER_CLIENT_DEPENDENCY", file);
  }
  if (
    file.includes("/client/") &&
    imports.some((name) => /^node:|^(?:fs|path|os|child_process)$|\/server\//.test(name))
  ) {
    throw failure("CLIENT_SERVER_DEPENDENCY", file);
  }
  checked++;
}
console.log(`Architecture boundaries checked: ${checked} source modules.`);
