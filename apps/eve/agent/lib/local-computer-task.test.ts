import { describe, expect, it } from "vitest";

import { localComputerTaskApproval } from "../tools/local_computer_task";

function context(role?: "guest") {
  return {
    toolName: "local_computer_task",
    session: {
      auth: {
        current:
          role === undefined
            ? null
            : {
                principalId: "group-participant",
                attributes: { role },
              },
        initiator: null,
      },
    },
  } as Parameters<typeof localComputerTaskApproval>[0];
}

describe("local_computer_task approval", () => {
  it("parks every owner task for one explicit approval", () => {
    expect(localComputerTaskApproval(context())).toBe("user-approval");
  });

  it("denies a guest instead of offering an approval prompt", () => {
    expect(localComputerTaskApproval(context("guest"))).toMatchObject({
      type: "denied",
    });
  });
});
