import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

export function change(): Command {
  const change_command = new Command("change");

  change_command
    .description("Update specification")
    .option("-v, --verbose", "Enable verbose output")
    .option("--name <name>", "Name of the specification folder")
    .action((command_options) => {
      try {
        if (!command_options.name) {
          console.error("Error: --name parameter is required");
          process.exit(1);
        }

        const project_git_root = find_git_root();
        const changes_directory_path = join(project_git_root, "changes");
        const specification_directory_path = join(project_git_root, "specification");

        // Ensure specification directory exists
        ensure_specification_directory_exists(specification_directory_path, command_options.verbose);

        // Ensure all specification template files exist
        ensure_specification_template_files_exist(specification_directory_path, command_options.verbose);

        // Ensure changes directory exists
        if (!existsSync(changes_directory_path)) {
          mkdirSync(changes_directory_path, { recursive: true });
          if (command_options.verbose) {
            console.log(`Changes directory created: ${changes_directory_path}`);
          }
        }

        const next_change_id = get_next_change_id(changes_directory_path);
        const change_name_kebab_case = convert_to_kebab_case(command_options.name);
        const change_folder_name = `${next_change_id}-${change_name_kebab_case}`;
        const change_directory_path = join(changes_directory_path, change_folder_name);

        // Create the new change folder
        mkdirSync(change_directory_path, { recursive: true });
        if (command_options.verbose) {
          console.log(`Folder created: ${change_directory_path}`);
        }

        // Copy change template file
        const current_file_url = fileURLToPath(import.meta.url);
        const current_directory_path = dirname(current_file_url);
        const change_template_file_path = join(current_directory_path, "../../templates/changes/01-CHANGE-ANALYSIS.md");
        const change_specification_file_path = join(change_directory_path, "01-CHANGE-ANALYSIS.md");

        if (existsSync(change_template_file_path)) {
          copyFileSync(change_template_file_path, change_specification_file_path);
          console.log(
            JSON.stringify({
              CHANGE_DIR_NAME: change_folder_name,
              CHANGE_NUM: next_change_id,
              BUSINESS_REQUIREMENTS: join(specification_directory_path, "01-BUSINESS-REQUIREMENTS-DOCUMENT.md"),
              FUNCTIONAL_SPECIFICATION: join(specification_directory_path, "02-FUNCTIONAL-SPECIFICATION.md"),
              UI_UX_GUIDELINES: join(specification_directory_path, "03-UI-UX-GUIDELINES.md"),
              DATA_REQUIREMENTS: join(specification_directory_path, "04-DATA-REQUIREMENTS.md"),
            }),
          );
        } else {
          console.error(`Template file not found: ${change_template_file_path}`);
          process.exit(1);
        }
      } catch (error) {
        console.error(`Error: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  return change_command;
}

function find_git_root(): string {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
  } catch (_error) {
    throw new Error("Not in a git repository or git not available");
  }
}

function convert_to_kebab_case(input_string: string): string {
  return input_string
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function get_next_change_id(changes_directory_path: string): string {
  if (!existsSync(changes_directory_path)) {
    return "001";
  }

  const existing_change_folders = readdirSync(changes_directory_path, { withFileTypes: true })
    .filter((directory_entry) => directory_entry.isDirectory())
    .map((directory_entry) => directory_entry.name)
    .filter((folder_name) => /^\d{3}-/.test(folder_name))
    .map((folder_name) => parseInt(folder_name.substring(0, 3), 10))
    .filter((folder_id) => !Number.isNaN(folder_id));

  if (existing_change_folders.length === 0) {
    return "001";
  }

  const highest_existing_change_id = Math.max(...existing_change_folders);
  return String(highest_existing_change_id + 1).padStart(3, "0");
}

function ensure_specification_directory_exists(specification_directory_path: string, verbose_output: boolean): void {
  if (!existsSync(specification_directory_path)) {
    mkdirSync(specification_directory_path, { recursive: true });
    if (verbose_output) {
      console.log(`Specification directory created: ${specification_directory_path}`);
    }
  }
}

function ensure_specification_template_files_exist(specification_directory_path: string, verbose_output: boolean): void {
  const current_file_url = fileURLToPath(import.meta.url);
  const current_directory_path = dirname(current_file_url);
  const specification_templates_directory_path = join(current_directory_path, "../../templates/specification");

  const specification_template_files = [
    "01-BUSINESS-REQUIREMENTS-DOCUMENT.md",
    "02-FUNCTIONAL-SPECIFICATION.md",
    "03-UI-UX-GUIDELINES.md",
    "04-DATA-REQUIREMENTS.md",
  ];

  for (const template_file_name of specification_template_files) {
    const template_source_path = join(specification_templates_directory_path, template_file_name);
    const template_destination_path = join(specification_directory_path, template_file_name);

    if (!existsSync(template_destination_path)) {
      if (existsSync(template_source_path)) {
        copyFileSync(template_source_path, template_destination_path);
        if (verbose_output) {
          console.log(`Specification template copied: ${template_file_name}`);
        }
      } else {
        console.error(`Template file not found: ${template_source_path}`);
        process.exit(1);
      }
    }
  }
}
