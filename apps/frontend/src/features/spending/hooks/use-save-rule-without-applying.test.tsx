import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { act, renderHook } from "@/test/render";

import { useSaveRuleWithoutApplying } from "./use-categorization-rules";

const platform = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("#platform", () => ({
  invoke: platform.invoke,
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useSaveRuleWithoutApplying", () => {
  beforeEach(() => platform.invoke.mockReset().mockResolvedValue({ id: "r1" }));

  // Saving a rule normally files what it matches at once; a suggested rule
  // must wait for the user's answer.
  it("creates a rule with the background categorize deferred", async () => {
    const { result } = renderHook(() => useSaveRuleWithoutApplying(), { wrapper });
    const rule = { name: "Tesco", pattern: "TESCO" };
    await act(() => result.current.mutateAsync({ rule }));

    expect(platform.invoke).toHaveBeenCalledTimes(1);
    expect(platform.invoke).toHaveBeenCalledWith("create_categorization_rule", {
      rule,
      deferApply: true,
    });
  });

  it("saves over an existing rule with the background categorize deferred", async () => {
    const { result } = renderHook(() => useSaveRuleWithoutApplying(), { wrapper });
    const rule = { name: "Tesco", pattern: "TESCO" };
    await act(() => result.current.mutateAsync({ rule, id: "r1" }));

    expect(platform.invoke).toHaveBeenCalledWith("update_categorization_rule", {
      id: "r1",
      patch: rule,
      deferApply: true,
    });
  });
});
