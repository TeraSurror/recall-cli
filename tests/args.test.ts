import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePathAndName, splitArgs } from "../src/util/args.ts";

let dir: string;
let spaced: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "recall-args-"));
  spaced = join(dir, "My Vault");
  mkdirSync(spaced);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("splitArgs handles quotes and backslash escapes", () => {
  expect(splitArgs('vault add "~/My Vault" work')).toEqual(["vault", "add", "~/My Vault", "work"]);
  expect(splitArgs("vault add '~/My Vault'")).toEqual(["vault", "add", "~/My Vault"]);
  expect(splitArgs("vault add ~/My\\ Vault  ")).toEqual(["vault", "add", "~/My Vault"]);
  expect(splitArgs('a "" b')).toEqual(["a", "", "b"]);
  expect(splitArgs('add "unterminated path')).toEqual(["add", "unterminated path"]);
});

test("parsePathAndName accepts unquoted paths with spaces when the folder exists", () => {
  expect(parsePathAndName(splitArgs(`${dir}/My Vault`))).toEqual({ path: spaced });
  expect(parsePathAndName(splitArgs(`${dir}/My Vault work`))).toEqual({ path: spaced, name: "work" });
  expect(parsePathAndName(splitArgs(`"${spaced}" work`))).toEqual({ path: spaced, name: "work" });
  expect(parsePathAndName([`file://${encodeURI(spaced)}`])).toEqual({ path: spaced, name: undefined });
  expect(parsePathAndName(["~/notes", "n"])).toEqual({ path: "~/notes", name: "n" });
  expect(parsePathAndName([])).toEqual({});
});
