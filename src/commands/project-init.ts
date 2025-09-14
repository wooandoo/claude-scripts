import { Command } from "commander";
import { copyFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

function find_git_root(): string {
  let current_directory = process.cwd();

  while (current_directory !== "/") {
    if (existsSync(join(current_directory, ".git"))) {
      return current_directory;
    }
    current_directory = dirname(current_directory);
  }

  throw new Error("Git repository not found");
}

export function projectInit(): Command {
  const project_init_command = new Command("project:init");

  project_init_command
    .description("Initialize project with MCP configuration")
    .option("-v, --verbose", "Enable verbose output")
    .action((command_options) => {
      try {
        const project_root = find_git_root();
        const mcp_config_destination = join(project_root, ".mcp.json");

        // Check if .mcp.json already exists
        if (existsSync(mcp_config_destination)) {
          console.log("MCP configuration already exists: .mcp.json");
          return;
        }

        // Get the template file path
        const current_file_url = fileURLToPath(import.meta.url);
        const current_directory_path = dirname(current_file_url);
        const mcp_template_file_path = join(current_directory_path, "../../templates/mcp.json");

        if (!existsSync(mcp_template_file_path)) {
          console.error(`Template file not found: ${mcp_template_file_path}`);
          process.exit(1);
        }

        // Copy the template file
        copyFileSync(mcp_template_file_path, mcp_config_destination);

        if (command_options.verbose) {
          console.log(`MCP configuration copied from: ${mcp_template_file_path}`);
          console.log(`MCP configuration created at: ${mcp_config_destination}`);
        } else {
          console.log("MCP configuration initialized: .mcp.json");
        }

      } catch (error) {
        console.error(`Error: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  return project_init_command;
}