import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getBenchData, switchModel } from "./server/bench";
import { benchData, benchSwitch } from "./shared/rpc";
import { preferences } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(preferences);
  server.handle(benchData, getBenchData);
  server.handle(benchSwitch, switchModel);
  return () => {};
}
