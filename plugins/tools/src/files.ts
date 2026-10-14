import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { toolError } from "./router.js";

export interface FileValue {
  readonly path: string;
  readonly content: string;
  readonly contentDigest: string;
}
export const contentDigest = (content: string) =>
  `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
export class FileTools {
  #work: Promise<void> = Promise.resolve();
  private constructor(
    readonly root: string,
    readonly access: "read" | "read-write",
  ) {}
  static async open(root: string, access: "read" | "read-write"): Promise<FileTools> {
    if (!isAbsolute(root)) throw toolError("CAPABILITY_DENIED");
    if (access === "read-write") await mkdir(root, { recursive: true });
    return new FileTools(await realpath(root), access);
  }
  async #path(path: string, allowMissing = false): Promise<string> {
    if (
      typeof path !== "string" ||
      !path ||
      path.includes("\0") ||
      isAbsolute(path) ||
      path.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
    )
      throw toolError("CAPABILITY_DENIED");
    const target = resolve(this.root, path);
    if (relative(this.root, target).startsWith(`..${sep}`) || target === this.root)
      throw toolError("CAPABILITY_DENIED");
    let current = this.root;
    const parts = path.split(sep);
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()))
          throw toolError("CAPABILITY_DENIED");
        if (index === parts.length - 1 && !stat.isFile()) throw toolError("CAPABILITY_DENIED");
      } catch (error) {
        if (
          allowMissing &&
          index === parts.length - 1 &&
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return target;
        throw error;
      }
    }
    return target;
  }
  async read(input: { readonly path: string }): Promise<FileValue> {
    const path = await this.#path(input.path);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await file.stat()).isFile()) throw toolError("CAPABILITY_DENIED");
      const content = new TextDecoder("utf-8", { fatal: true }).decode(await file.readFile());
      return { path: input.path, content, contentDigest: contentDigest(content) };
    } finally {
      await file.close();
    }
  }
  write(input: {
    readonly path: string;
    readonly expectedContentDigest: string | null;
    readonly newContent: string;
  }): Promise<FileValue> {
    const work = this.#work.then(() => this.#write(input));
    this.#work = work.then(
      () => {},
      () => {},
    );
    return work;
  }
  async #write(input: {
    readonly path: string;
    readonly expectedContentDigest: string | null;
    readonly newContent: string;
  }): Promise<FileValue> {
    if (this.access !== "read-write") throw toolError("CAPABILITY_DENIED");
    if (
      typeof input.newContent !== "string" ||
      (input.expectedContentDigest !== null &&
        !/^sha256:[0-9a-f]{64}$/.test(input.expectedContentDigest))
    )
      throw toolError("INVALID_INPUT");
    const target = await this.#path(input.path, true);
    let current: FileValue | null = null;
    try {
      current = await this.read({ path: input.path });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if ((current?.contentDigest ?? null) !== input.expectedContentDigest)
      throw toolError("REVISION_CONFLICT");
    const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
    let renamed = false;
    try {
      const file = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(input.newContent, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await this.#path(input.path, true);
      await rename(temporary, target);
      renamed = true;
      const observed = await this.read({ path: input.path });
      if (observed.content !== input.newContent) throw toolError("FILE_OUTCOME_UNKNOWN");
      return observed;
    } finally {
      if (!renamed) await unlink(temporary).catch(() => {});
    }
  }
}
