import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    datasetId: z.string().optional(),
    hidden: z.array(z.string()).default([]),
  }),
});
