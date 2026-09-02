import { describe, expect, test } from "bun:test";

import { Herdr, HerdrCommandError, HerdrJsonError, type CommandRunner } from "../src/client/herdr.ts";

function failingRunner(stderr: string, exitCode = 1): CommandRunner {
  return async () => ({ stdout: "", stderr, exitCode });
}

async function catchFrom(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the command to fail");
}

describe("herdr client error hygiene", () => {
  test("command failure message names only the command family and exit code", async () => {
    const herdr = new Herdr({ runner: failingRunner("boom") });

    const error = await catchFrom(herdr.run(["workspace", "focus", "/home/adversary/secret w9"])) as HerdrCommandError;

    expect(error).toBeInstanceOf(HerdrCommandError);
    expect(error.message).toBe("herdr workspace failed (exit 1)");
    expect(error.message).not.toContain("/Users");
    expect(error.message).not.toContain("w9");
  });

  test("retains bounded sanitized stderr for dispatch classification", async () => {
    const osc = "\u001B]0;pwned\u0007permission denied for worktree";
    const herdr = new Herdr({ runner: failingRunner(osc) });

    const error = await catchFrom(herdr.run(["worktree", "open", "--path", "/repo/x"])) as HerdrCommandError;

    expect(error.stderr).toBe("permission denied for worktree");
    expect(error.stderr).not.toContain("\u001B");
  });

  test("replaces C0 and C1 controls inside retained stderr", async () => {
    const noisy = "no worktree\u0000\u009B31m found";
    const herdr = new Herdr({ runner: failingRunner(noisy) });

    const error = await catchFrom(herdr.run(["worktree", "open"])) as HerdrCommandError;

    // The C1 byte 0x9B starts a CSI sequence, so "31m" is consumed as its
    // parameters and final byte rather than surviving as text.
    expect(error.stderr).toBe("no worktree found");
  });

  test("truncates very long stderr detail", async () => {
    const herdr = new Herdr({ runner: failingRunner("x".repeat(10_000)) });

    const error = await catchFrom(herdr.run(["workspace", "list"])) as HerdrCommandError;

    expect(error.stderr.length).toBeLessThanOrEqual(1024);
  });

  test("malformed JSON yields a generic message without raw stdout", async () => {
    const runner: CommandRunner = async () => ({ stdout: "not json at all /home/adversary/leak", stderr: "", exitCode: 0 });
    const herdr = new Herdr({ runner });

    const error = await catchFrom(herdr.json(["workspace", "list"])) as HerdrJsonError;

    expect(error).toBeInstanceOf(HerdrJsonError);
    expect(error.message).toBe("herdr workspace returned invalid JSON");
    expect(error.message).not.toContain("/Users");
    expect((error as { stdout?: unknown }).stdout).toBeUndefined();
  });
});
