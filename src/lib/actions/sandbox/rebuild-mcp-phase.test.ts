// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeSandboxCommand: vi.fn(),
  executeSandboxExecCommand: vi.fn(),
  prepareAbsent: vi.fn(),
  prepareExecUnavailable: vi.fn(),
  prepareLive: vi.fn(),
}));

vi.mock("./mcp-bridge", () => ({
  prepareMcpBridgesForAbsentSandboxRebuild: mocks.prepareAbsent,
  prepareMcpBridgesForExecUnavailableRebuild: mocks.prepareExecUnavailable,
  prepareMcpBridgesForRebuild: mocks.prepareLive,
  reattachMcpProvidersAfterRebuildAbort: vi.fn(),
  restoreMcpBridgesAfterRebuild: vi.fn(),
}));

vi.mock("./process-recovery", () => ({
  executeSandboxCommand: mocks.executeSandboxCommand,
  executeSandboxExecCommand: mocks.executeSandboxExecCommand,
}));

import {
  prepareMcpForRebuild,
  printMcpRebuildRetryCommand,
  printMcpRestoreRecovery,
} from "./rebuild-mcp-phase";

const emptyPreparation = {
  entries: [],
  detachedProviderEntries: [],
  scrubbedAdapterEntries: [],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("forced rebuild MCP preparation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.executeSandboxCommand.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    mocks.executeSandboxExecCommand.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    mocks.prepareAbsent.mockResolvedValue(emptyPreparation);
    mocks.prepareExecUnavailable.mockResolvedValue(emptyPreparation);
    mocks.prepareLive.mockResolvedValue(emptyPreparation);
  });

  it("uses host-side recovery when OpenShell exec fails even while SSH is healthy (#7062)", async () => {
    mocks.executeSandboxExecCommand.mockReturnValue(null);
    const relock = vi.fn(() => true);
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });

    await expect(prepareMcpForRebuild("alpha", false, true, relock, bail)).resolves.toEqual(
      emptyPreparation,
    );

    expect(mocks.executeSandboxExecCommand).toHaveBeenCalledWith("alpha", ":", undefined, {
      allowLocalDockerFallback: false,
    });
    expect(mocks.executeSandboxCommand).toHaveBeenCalledWith("alpha", ":");
    expect(mocks.prepareExecUnavailable).toHaveBeenCalledWith("alpha");
    expect(mocks.prepareAbsent).not.toHaveBeenCalled();
    expect(mocks.prepareLive).not.toHaveBeenCalled();
    expect(relock).not.toHaveBeenCalled();
  });

  it("uses host-side recovery when SSH fails even while OpenShell exec is healthy (#7062)", async () => {
    mocks.executeSandboxCommand.mockReturnValue(null);
    const relock = vi.fn(() => true);
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });

    await expect(prepareMcpForRebuild("alpha", false, true, relock, bail)).resolves.toEqual(
      emptyPreparation,
    );

    expect(mocks.executeSandboxCommand).toHaveBeenCalledWith("alpha", ":");
    expect(mocks.executeSandboxExecCommand).toHaveBeenCalledWith("alpha", ":", undefined, {
      allowLocalDockerFallback: false,
    });
    expect(mocks.prepareExecUnavailable).toHaveBeenCalledWith("alpha");
    expect(mocks.prepareLive).not.toHaveBeenCalled();
    expect(mocks.prepareAbsent).not.toHaveBeenCalled();
    expect(relock).not.toHaveBeenCalled();
  });

  it("uses host-side recovery when SSH exits nonzero even while OpenShell exec is healthy (#7062)", async () => {
    mocks.executeSandboxCommand.mockReturnValue({
      status: 255,
      stdout: "",
      stderr: "relay EOF",
    });
    const relock = vi.fn(() => true);
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });

    await expect(prepareMcpForRebuild("alpha", false, true, relock, bail)).resolves.toEqual(
      emptyPreparation,
    );

    expect(mocks.executeSandboxExecCommand).toHaveBeenCalledWith("alpha", ":", undefined, {
      allowLocalDockerFallback: false,
    });
    expect(mocks.prepareExecUnavailable).toHaveBeenCalledWith("alpha");
    expect(mocks.prepareLive).not.toHaveBeenCalled();
    expect(relock).not.toHaveBeenCalled();
  });

  it.each([
    1, 64, 126, 127, 255,
  ])("routes every nonzero exec result (%i) through explicit force recovery (#7062)", async (status) => {
    mocks.executeSandboxExecCommand.mockReturnValue({
      status,
      stdout: "",
      stderr: "exec failed",
    });
    const relock = vi.fn(() => true);
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });

    await expect(prepareMcpForRebuild("alpha", false, true, relock, bail)).resolves.toEqual(
      emptyPreparation,
    );

    expect(mocks.prepareExecUnavailable).toHaveBeenCalledWith("alpha");
    expect(mocks.prepareLive).not.toHaveBeenCalled();
    expect(mocks.prepareAbsent).not.toHaveBeenCalled();
    expect(relock).not.toHaveBeenCalled();
  });

  it("does not mask a live-path safety failure after a successful exec probe (#7062)", async () => {
    mocks.prepareLive.mockRejectedValue(new Error("generated policy drifted"));
    const relock = vi.fn(() => true);
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });

    await expect(prepareMcpForRebuild("alpha", false, true, relock, bail)).rejects.toThrow(
      "Failed to preserve MCP bridges before rebuild: generated policy drifted",
    );

    expect(mocks.prepareLive).toHaveBeenCalledWith("alpha");
    expect(mocks.executeSandboxCommand).toHaveBeenCalledWith("alpha", ":");
    expect(mocks.executeSandboxExecCommand).toHaveBeenCalledWith("alpha", ":", undefined, {
      allowLocalDockerFallback: false,
    });
    expect(mocks.prepareAbsent).not.toHaveBeenCalled();
    expect(relock).toHaveBeenCalledWith(true);
  });

  it("fails closed when host-side recovery cannot prove durable ownership (#7062)", async () => {
    mocks.executeSandboxExecCommand.mockReturnValue({
      status: 255,
      stdout: "",
      stderr: "relay EOF",
    });
    mocks.prepareExecUnavailable.mockRejectedValue(new Error("provider ownership is ambiguous"));
    const relock = vi.fn(() => true);
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });

    await expect(prepareMcpForRebuild("alpha", false, true, relock, bail)).rejects.toThrow(
      "Failed to preserve MCP bridges before rebuild (--force host-side recovery): provider ownership is ambiguous",
    );

    expect(mocks.prepareLive).not.toHaveBeenCalled();
    expect(mocks.prepareAbsent).not.toHaveBeenCalled();
    expect(relock).toHaveBeenCalledWith(true);
  });

  it("does not probe or use host-side recovery without explicit force (#7062)", async () => {
    const relock = vi.fn(() => true);
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });

    await expect(prepareMcpForRebuild("alpha", false, false, relock, bail)).resolves.toEqual(
      emptyPreparation,
    );

    expect(mocks.executeSandboxExecCommand).not.toHaveBeenCalled();
    expect(mocks.executeSandboxCommand).not.toHaveBeenCalled();
    expect(mocks.prepareLive).toHaveBeenCalledWith("alpha");
    expect(mocks.prepareExecUnavailable).not.toHaveBeenCalled();
    expect(mocks.prepareAbsent).not.toHaveBeenCalled();
  });

  it("keeps already-absent stale recovery on its established host-side path (#7062)", async () => {
    const relock = vi.fn(() => true);
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });

    await expect(prepareMcpForRebuild("alpha", true, true, relock, bail)).resolves.toEqual(
      emptyPreparation,
    );

    expect(mocks.executeSandboxExecCommand).not.toHaveBeenCalled();
    expect(mocks.executeSandboxCommand).not.toHaveBeenCalled();
    expect(mocks.prepareAbsent).toHaveBeenCalledWith("alpha");
    expect(mocks.prepareExecUnavailable).not.toHaveBeenCalled();
    expect(mocks.prepareLive).not.toHaveBeenCalled();
  });
});

describe("MCP rebuild retry guidance", () => {
  it.each([
    [true, "--observability"],
    [false, "--no-observability"],
  ])("preserves an explicit observability=%s override", (enabled, expectedFlag) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    printMcpRebuildRetryCommand("alpha", [{} as never], "progressive", {
      enabled,
      requestedExplicitly: true,
    });

    const output = error.mock.calls.flat().join("\n");
    expect(output).toContain(
      `nemoclaw alpha rebuild --yes --tool-disclosure progressive ${expectedFlag}`,
    );
  });

  it("preserves an explicit opt-out on the resume retry form", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    printMcpRebuildRetryCommand("alpha", [], "direct", {
      enabled: false,
      requestedExplicitly: true,
    });

    expect(error.mock.calls.flat().join("\n")).toContain(
      "nemoclaw onboard --resume --name alpha --tool-disclosure direct --no-observability",
    );
  });

  it("names the sandbox on the resume retry form so the printed command is runnable", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    printMcpRebuildRetryCommand("alpha", [], "progressive");

    const command = error.mock.calls.flat().find((line) => line.includes("onboard --resume"));
    expect(command).toContain("nemoclaw onboard --resume --name alpha");
  });

  it("does not turn inherited observability state into an explicit retry override", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    printMcpRebuildRetryCommand("alpha", [{} as never], "progressive", {
      enabled: true,
      requestedExplicitly: false,
    });

    const command = error.mock.calls.flat().find((line) => line.includes("rebuild --yes"));
    expect(command).not.toContain("--observability");
    expect(command).not.toContain("--no-observability");
  });

  it("keeps inherited observability state implicit on the resume retry form", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    printMcpRebuildRetryCommand("alpha", [], "progressive", {
      enabled: false,
      requestedExplicitly: false,
    });

    const command = error.mock.calls.flat().find((line) => line.includes("onboard --resume"));
    expect(command).not.toContain("--observability");
    expect(command).not.toContain("--no-observability");
  });

  it.each([
    "disabled",
    "thread-opt-in",
  ] as const)("preserves an explicit DCode auto-approval=%s override", (mode) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    printMcpRebuildRetryCommand("alpha", [{} as never], "progressive", undefined, {
      mode,
      requestedExplicitly: true,
    });

    expect(error.mock.calls.flat().join("\n")).toContain(
      `nemoclaw alpha rebuild --yes --tool-disclosure progressive --dcode-auto-approval ${mode}`,
    );
  });

  it("keeps inherited DCode auto-approval state implicit on retry", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    printMcpRebuildRetryCommand("alpha", [{} as never], "progressive", undefined, {
      mode: "thread-opt-in",
      requestedExplicitly: false,
    });

    const command = error.mock.calls.flat().find((line) => line.includes("rebuild --yes"));
    expect(command).not.toContain("--dcode-auto-approval");
  });
});

describe("MCP restore recovery guidance", () => {
  it("adds the shields-down step when the rebuild restores lockdown for a shields-gated adapter (#10751)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    printMcpRestoreRecovery("alpha", true, true);

    const lines = log.mock.calls.flat().map(String);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("then run `nemoclaw alpha mcp restart`");
    expect(lines[1]).toContain("Shields must be down for `mcp restart`");
    expect(lines[1]).toContain(
      'run `nemoclaw alpha shields down --timeout 15m --reason "MCP maintenance"` before the restart',
    );
    expect(lines[1]).toContain("then `nemoclaw alpha shields up` after it succeeds");
  });

  it("keeps the single-line guidance when the retry does not need shields down (#10751)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    printMcpRestoreRecovery("alpha", true, false);

    const lines = log.mock.calls.flat().map(String);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("then run `nemoclaw alpha mcp restart`");
    expect(lines[0]).not.toContain("shields");
  });

  it("prints nothing when MCP restoration was verified (#10751)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    printMcpRestoreRecovery("alpha", false, true);

    expect(log).not.toHaveBeenCalled();
  });
});
