import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 2,
  // v2 made the AA Coding Agent Index the default, so start everyone on it again.
  migrate: () => ({}),
  schema: z.object({
    datasetId: z.string().optional(),
    hidden: z.array(z.string()).default([]),
  }),
});
