import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 2,
  // v2 changed the default benchmark, so older saved choices are dropped.
  migrate: () => ({}),
  schema: z.object({
    datasetId: z.string().optional(),
    // Last provider seen in a session; the draft popup starts on it.
    provider: z.string().optional(),
    hidden: z.array(z.string()).default([]),
  }),
});
