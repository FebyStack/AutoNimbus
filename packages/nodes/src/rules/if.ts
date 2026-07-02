import { AppError, type NodeModule } from "@autonimbus/shared";

export const ifRule: NodeModule = {
  manifest: {
    slug: "core.if",
    kind: "rule",
    name: "If…",
    description: "Continues down the matching branch based on a simple comparison.",
    inputHint: "Data with the field you want to compare.",
    outputHint: "true or false — which branch to follow.",
  },
  async run(ctx) {
    const { field, operator, value } = ctx.config as {
      field: string;
      operator: string;
      value: unknown;
    };
    const actual = (ctx.input as Record<string, unknown> | undefined)?.[field];
    switch (operator) {
      case "equals":
        return actual === value;
      case "lessThan":
        return Number(actual) < Number(value);
      case "greaterThan":
        return Number(actual) > Number(value);
      case "contains":
        return String(actual).toLowerCase().includes(String(value).toLowerCase());
      default:
        throw new AppError({
          code: "RULE_UNKNOWN_OPERATOR",
          friendlyMessage: `The If rule doesn't understand "${operator}".`,
          suggestedFix: "Use equals, lessThan, greaterThan, or contains.",
        });
    }
  },
};
