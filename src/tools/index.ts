import {
  editFileTool,
  globFilesTool,
  grepFilesTool,
  listFilesTool,
  readFileTool,
  writeFileTool,
} from "./filesystem.ts";
import { ToolRegistry } from "./registry.ts";
import { bashTool } from "./shell.ts";

/** The default toolset. Add `.register(yourTool)` to give the agent a new ability. */
export function buildToolRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(readFileTool)
    .register(writeFileTool)
    .register(editFileTool)
    .register(listFilesTool)
    .register(globFilesTool)
    .register(grepFilesTool)
    .register(bashTool);
}
