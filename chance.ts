import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

type CoinDetails = { result: number; outcome: "heads" | "tails" };
type DiceParams = { sides?: number[] };
type DiceDetails = {
  sides: number[];
  rolls: number[];
  total: number;
  cup: string[];
};

const flipCoinTool: ToolDefinition<{}, CoinDetails> = {
  name: "flip_coin",
  label: "Flip coin",
  description: "Flip a fair coin and report heads or tails.",
  promptSnippet: "Flip a coin and return heads or tails.",
  parameters: Type.Object({}),
  async execute() {
    const result = Math.floor(Math.random() * 2);
    const outcome: CoinDetails["outcome"] = result === 0 ? "heads" : "tails";
    return {
      content: [
        {
          type: "text",
          text: `flip_coin -> ${outcome}`,
        },
      ],
      details: { result, outcome },
    };
  },
};

const rollDiceTool: ToolDefinition<DiceParams, DiceDetails> = {
  name: "roll_dice",
  label: "Roll dice",
  description:
    "Roll dice. Supply an array of side counts (e.g., [6,20,8]) to roll multiple dice and get the individual rolls plus grouped totals.",
  promptSnippet: "Roll dice (e.g., /roll_dice [6,20]).",
  parameters: Type.Object({
    sides: Type.Optional(
      Type.Array(Type.Integer({ minimum: 2 }), {
        description: "Sides for each die to roll",
      }),
    ),
  }),
  async execute(_toolCallId, params) {
    const sides = params.sides && params.sides.length > 0 ? params.sides : [6];
    const rolls = sides.map((s) => Math.floor(Math.random() * s) + 1);
    const total = rolls.reduce((sum, roll) => sum + roll, 0);
    const cup = Object.entries(
      sides.reduce((acc, side) => {
        const label = `d${side}`;
        acc[label] = (acc[label] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    ).map(([die, count]) => `${count}${die}`);

    const rollExpression = rolls.join(" + ");
    const allSameDie = new Set(sides).size === 1;
    const includeTotal = rolls.length > 1;

    let summaryText = `Rolled ${cup.join(", ")}: ${rollExpression}`;
    if (includeTotal) {
      summaryText += ` = ${total}`;
      if (!allSameDie) {
        summaryText += " (grand total)";
      }
    }

    return {
      content: [
        {
          type: "text",
          text: summaryText,
        },
      ],
      details: {
        sides,
        rolls,
        total,
        cup,
      },
    };
  },
};

export default function chanceTools(pi: ExtensionAPI) {
  pi.registerTool(flipCoinTool);
  pi.registerTool(rollDiceTool);
}
