import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

export function newSpecification(): Command {
  const cmd = new Command("spec:new");

  cmd
    .description("Create a new specification")
    .option("-v, --verbose", "Enable verbose output")
    .option("--name <name>", "Name of the specification folder")
    .action((options) => {
      try {
        if (!options.name) {
          console.error("Error: --name parameter is required");
          process.exit(1);
        }

        const gitRoot = findGitRoot();
        const changesDir = join(gitRoot, "changes");

        // Ensure changes directory exists
        if (!existsSync(changesDir)) {
          mkdirSync(changesDir, { recursive: true });
          if (options.verbose) {
            console.log(`Changes directory created: ${changesDir}`);
          }
        }

        const nextId = getNextId(changesDir);
        const kebabName = toKebabCase(options.name);
        const folderName = `${nextId}-${kebabName}`;
        const newDir = join(changesDir, folderName);

        // Create the new folder
        mkdirSync(newDir, { recursive: true });
        if (options.verbose) {
          console.log(`Folder created: ${newDir}`);
        }

        // Copy template file
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        const templatePath = join(__dirname, "../../templates/SPECIFICATION.md");
        const specPath = join(newDir, "spec.md");

        if (existsSync(templatePath)) {
          copyFileSync(templatePath, specPath);
          console.log(`Folder created: ${folderName}`);
          console.log(`Spec file: changes/${folderName}/spec.md`);
          console.log(`Number: ${nextId}`);
        } else {
          console.error(`Template file not found: ${templatePath}`);
          process.exit(1);
        }
      } catch (error) {
        console.error(`Error: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  return cmd;
}

function findGitRoot(): string {
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
    return gitRoot;
  } catch (_error) {
    throw new Error("Not in a git repository or git not available");
  }
}

function toKebabCase(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getNextId(changesDir: string): string {
  if (!existsSync(changesDir)) {
    return "001";
  }

  const folders = readdirSync(changesDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name)
    .filter((name) => /^\d{3}-/.test(name))
    .map((name) => parseInt(name.substring(0, 3), 10))
    .filter((num) => !Number.isNaN(num));

  if (folders.length === 0) {
    return "001";
  }

  const maxId = Math.max(...folders);
  return String(maxId + 1).padStart(3, "0");
}
