import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const point = z.object({
  label: z.string(),
  thinkingOptionId: z.string().nullable(),
  score: z.number(),
  cost: z.number(),
});

export const benchData = defineRpc({
  name: "bench.data",
  input: z.object({ provider: z.string(), datasetId: z.string().optional() }),
  output: z.object({
    datasetId: z.string(),
    datasets: z.array(z.object({ id: z.string(), label: z.string(), unit: z.string(), source: z.string() })),
    series: z.array(z.object({ label: z.string(), modelId: z.string(), points: z.array(point) })),
  }),
});

export const benchSwitch = defineRpc({
  name: "bench.switch",
  input: z.object({
    agentId: z.string(),
    modelId: z.string(),
    thinkingOptionId: z.string().nullable(),
  }),
  output: z.object({}),
});
