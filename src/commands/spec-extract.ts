import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Command } from "commander";

interface SpecInfo {
  name: string;
  description: string;
  tags: string[];
  cases: TestCase[];
}

interface TestCase {
  name: string;
  given: string[];
  when: string[];
  then: string[];
  rules: Rule[];
}

interface Rule {
  description: string;
  domain: string[];
}

export function specExtract(): Command {
  const spec_extract_command = new Command("spec:extract");

  spec_extract_command
    .description("Extract information from .spec.ts files in a directory and generate a JSON file")
    .argument("<directory>", "Directory to scan for .spec.ts files")
    .option("-o, --output <file>", "Output JSON file path", "spec.json")
    .option("--stdout", "Output to console instead of file")
    .option("-v, --verbose", "Enable verbose output")
    .action((directory, command_options) => {
      try {
        const spec_files = find_spec_files(directory, command_options.verbose);

        if (spec_files.length === 0) {
          console.log("No .spec.ts files found in the specified directory.");
          return;
        }

        const extracted_data: Record<string, SpecInfo> = {};

        for (const spec_file_path of spec_files) {
          if (command_options.verbose) {
            console.log(`Processing: ${spec_file_path}`);
          }

          const relative_path = relative(directory, spec_file_path);
          const spec_info = extract_spec_info(spec_file_path, command_options.verbose);

          if (spec_info) {
            extracted_data[relative_path] = spec_info;
          }
        }

        // Output the JSON
        const json_output = JSON.stringify(extracted_data, null, 2);
        
        if (command_options.stdout) {
          // Output to console
          console.log(json_output);
          if (command_options.verbose) {
            console.error(`Extraction completed. ${Object.keys(extracted_data).length} spec files processed.`);
          }
        } else {
          // Output to file
          writeFileSync(command_options.output, json_output, "utf-8");
          console.log(`Extraction completed. ${Object.keys(extracted_data).length} spec files processed.`);
          console.log(`Output written to: ${command_options.output}`);
        }
      } catch (error) {
        console.error(`Error: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  return spec_extract_command;
}

function find_spec_files(directory: string, verbose: boolean = false): string[] {
  const spec_files: string[] = [];

  function scan_directory(current_dir: string): void {
    try {
      const entries = readdirSync(current_dir, { withFileTypes: true });

      for (const entry of entries) {
        const full_path = join(current_dir, entry.name);

        if (entry.isDirectory()) {
          scan_directory(full_path);
        } else if (entry.isFile() && entry.name.endsWith(".spec.ts")) {
          spec_files.push(full_path);
          if (verbose) {
            console.log(`Found spec file: ${full_path}`);
          }
        }
      }
    } catch (error) {
      if (verbose) {
        console.warn(`Warning: Could not read directory ${current_dir}: ${(error as Error).message}`);
      }
    }
  }

  scan_directory(directory);
  return spec_files;
}

function extract_spec_info(file_path: string, verbose: boolean = false): SpecInfo | null {
  try {
    const file_content = readFileSync(file_path, "utf-8");

    // Extract JSDoc comments and tags
    const jsdoc_match = file_content.match(/\/\*\*[\s\S]*?\*\//);
    let description = "";
    let tags: string[] = [];

    if (jsdoc_match) {
      const jsdoc_content = jsdoc_match[0];

      // Extract description (lines that don't start with @)
      const description_lines = jsdoc_content
        .split("\n")
        .map((line) => line.replace(/^\s*\*\s?/, ""))
        .filter((line) => !line.startsWith("@") && !line.includes("/**") && !line.includes("*/") && !line.includes("/"))
        .filter((line) => line.trim().length > 0);

      description = description_lines.join("\n").trim();

      // Extract tags
      const tag_matches = jsdoc_content.match(/@tag\s+(\w+)/g);
      if (tag_matches) {
        tags = tag_matches.map((match) => match.replace(/@tag\s+/, ""));
      }
    }

    // Extract describe block name
    const describe_match = file_content.match(/describe\s*\(\s*['"`]([^'"`]+)['"`]/);
    const test_suite_name = describe_match ? describe_match[1] : "";

    // Extract test cases with their Given/When/Then structure
    const test_cases = extract_test_cases(file_content);

    return {
      name: test_suite_name,
      description: description,
      tags: tags,
      cases: test_cases,
    };
  } catch (error) {
    if (verbose) {
      console.warn(`Warning: Could not process file ${file_path}: ${(error as Error).message}`);
    }
    return null;
  }
}

function extract_test_cases(file_content: string): TestCase[] {
  const test_cases: TestCase[] = [];

  // Find all it() blocks
  const it_regex = /it\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\(\s*\)\s*=>\s*\{([\s\S]*?)\}\s*\)/g;
  let match: RegExpExecArray | null;

  match = it_regex.exec(file_content);
  while (match !== null) {
    const test_name = match[1];
    const test_body = match[2];

    const given_statements = extract_statements(test_body, "GIVEN");
    const when_statements = extract_statements(test_body, "WHEN");
    const then_statements = extract_statements(test_body, "THEN");
    const rules = extract_rules(test_body);

    test_cases.push({
      name: test_name,
      given: given_statements,
      when: when_statements,
      "then": then_statements,
      rules: rules,
    });
    
    match = it_regex.exec(file_content);
  }

  return test_cases;
}

function extract_statements(test_body: string, keyword: string): string[] {
  const statements: string[] = [];
  const lines = test_body.split("\n");
  
  let in_section = false;
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    if (trimmed.startsWith(`// ${keyword} `)) {
      in_section = true;
      const statement = trimmed.replace(`// ${keyword} `, "");
      if (statement) {
        statements.push(statement);
      }
    } else if (in_section && trimmed.startsWith("// AND ")) {
      const statement = trimmed.replace("// AND ", "");
      if (statement) {
        statements.push(statement);
      }
    } else if (trimmed.startsWith("// GIVEN ") || trimmed.startsWith("// WHEN ") || trimmed.startsWith("// THEN ")) {
      // Stop collecting when we hit another section
      if (!trimmed.startsWith(`// ${keyword} `)) {
        in_section = false;
      }
    }
  }

  return statements;
}

function extract_rules(test_body: string): Rule[] {
  const rules: Rule[] = [];
  const lines = test_body.split("\n");
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Match RULE: description or RULE(domain): description
    const rule_match = trimmed.match(/^\/\/ RULE(?:\(([^)]+)\))?: (.+)$/);
    
    if (rule_match) {
      const domain_part = rule_match[1];
      const description = rule_match[2];
      
      let domains: string[];
      if (domain_part) {
        // Parse domain(s) - could be comma separated
        domains = domain_part.split(',').map(d => d.trim()).map(d => `@${d}`);
      } else {
        // No domain specified, use @global
        domains = ["@global"];
      }
      
      rules.push({
        description: description,
        domain: domains
      });
    }
  }
  
  return rules;
}
