import { Command } from "commander";
import { readdirSync, statSync, readFileSync, writeFileSync } from "fs";
import { join, relative, extname } from "path";

interface EntityInfo {
  name: string;
  tableName: string;
  columns: ColumnInfo[];
  primaryKeys: string[];
  foreignKeys: ForeignKeyInfo[];
  indexes: IndexInfo[];
  checks: CheckInfo[];
}

interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue?: string;
  primaryKey: boolean;
  unique: boolean;
  references?: {
    table: string;
    column: string;
  };
}

interface ForeignKeyInfo {
  columns: string[];
  references: {
    table: string;
    columns: string[];
  };
}

interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
}

interface CheckInfo {
  name: string;
  expression: string;
}

function find_schema_files(directory: string, verbose = false): string[] {
  const schema_files: string[] = [];

  function scan_directory(dir: string): void {
    const entries = readdirSync(dir);

    for (const entry of entries) {
      const full_path = join(dir, entry);
      const stat = statSync(full_path);

      if (stat.isDirectory()) {
        scan_directory(full_path);
      } else if (stat.isFile()) {
        // Check for schema files: .ts files that likely contain Drizzle schema
        if (extname(entry) === '.ts') {
          const content = readFileSync(full_path, 'utf-8');
          // Look for Drizzle table definitions
          if (content.includes('Table') && 
              (content.includes('pgTable') || content.includes('mysqlTable') || content.includes('sqliteTable'))) {
            schema_files.push(full_path);
            if (verbose) {
              console.log(`Found schema file: ${full_path}`);
            }
          }
        }
      }
    }
  }

  const stat = statSync(directory);
  if (stat.isFile()) {
    // Single file provided
    schema_files.push(directory);
  } else {
    scan_directory(directory);
  }

  return schema_files;
}

function extract_entities_from_file(file_path: string, verbose = false): EntityInfo[] {
  const content = readFileSync(file_path, 'utf-8');
  const entities: EntityInfo[] = [];

  try {
    // Improved parser to handle multiline table definitions
    // Look for table definitions and extract the complete column block
    const table_start_regex = /export\s+const\s+(\w+)\s*=\s*(pg|mysql|sqlite)Table\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{/g;
    let match;
    
    while ((match = table_start_regex.exec(content)) !== null) {
      const [full_match, variable_name, dialect, table_name] = match;
      const start_pos = match.index + full_match.length - 1; // Position of opening {
      
      // Find the matching closing brace
      let brace_count = 1;
      let end_pos = start_pos + 1;
      
      while (end_pos < content.length && brace_count > 0) {
        if (content[end_pos] === '{') {
          brace_count++;
        } else if (content[end_pos] === '}') {
          brace_count--;
        }
        end_pos++;
      }
      
      if (brace_count === 0) {
        const columns_content = content.substring(start_pos + 1, end_pos - 1);
        
        if (verbose) {
          console.log(`Found table: ${variable_name} -> ${table_name}`);
          console.log(`Columns content: ${columns_content.substring(0, 100)}...`);
        }
        
        const entity: EntityInfo = {
          name: variable_name,
          tableName: table_name,
          columns: extract_columns_from_content(columns_content, verbose),
          primaryKeys: [],
          foreignKeys: [],
          indexes: [],
          checks: []
        };
        
        // Extract additional constraints if present
        extract_constraints(columns_content, entity, verbose);
        
        entities.push(entity);
      }
    }
    
    return entities;
  } catch (error) {
    if (verbose) {
      console.error(`Error parsing file ${file_path}: ${(error as Error).message}`);
    }
    return [];
  }
}

function extract_columns_from_content(columns_content: string, verbose = false): ColumnInfo[] {
  const columns: ColumnInfo[] = [];
  
  // Improved parsing to handle Drizzle column definitions
  // Split by commas but be careful with nested parentheses
  const lines = columns_content.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  
  for (const line of lines) {
    // Match column definition: columnName: columnType(params).methods()
    const column_match = line.match(/^(\w+):\s*(.+?)(?:,\s*$|$)/);
    if (!column_match) continue;
    
    const [, column_name, column_definition] = column_match;
    
    const column: ColumnInfo = {
      name: column_name,
      type: extract_base_type(column_definition),
      nullable: !column_definition.includes('.notNull()'),
      primaryKey: column_definition.includes('.primaryKey()'),
      unique: column_definition.includes('.unique()'),
      defaultValue: extract_default_value(column_definition)
    };
    
    // Check for references
    const references_match = column_definition.match(/\.references\(\s*\(\)\s*=>\s*(\w+)\.(\w+)/);
    if (references_match) {
      column.references = {
        table: references_match[1],
        column: references_match[2]
      };
    }
    
    columns.push(column);
    
    if (verbose) {
      console.log(`  Column: ${column_name} (${column.type})`);
    }
  }
  
  return columns;
}

function extract_base_type(definition: string): string {
  // Extract the base type from the column definition
  const type_match = definition.match(/^(\w+)/);
  return type_match ? type_match[1] : 'unknown';
}

function extract_default_value(definition: string): string | undefined {
  const default_match = definition.match(/\.default\(([^)]+)\)/);
  return default_match ? default_match[1] : undefined;
}

function extract_constraints(table_definition: string, entity: EntityInfo, verbose = false): void {
  // Look for primary key constraints
  entity.primaryKeys = entity.columns.filter(col => col.primaryKey).map(col => col.name);
  
  // This is a simplified implementation
  // A full implementation would parse composite keys, foreign keys, indexes, etc.
}

export function entitiesExtract(): Command {
  const entities_extract_command = new Command("entities:extract");

  entities_extract_command
    .description("Extract entity information from Drizzle schema files and generate a JSON file")
    .argument("<path>", "Path to schema file or directory containing schema files")
    .option("-o, --output <file>", "Output JSON file path", "entities.json")
    .option("--stdout", "Output to console instead of file")
    .option("-v, --verbose", "Enable verbose output")
    .action((path, command_options) => {
      try {
        const schema_files = find_schema_files(path, command_options.verbose);

        if (schema_files.length === 0) {
          console.log("No Drizzle schema files found in the specified path.");
          return;
        }

        const extracted_data: Record<string, EntityInfo[]> = {};

        for (const schema_file_path of schema_files) {
          if (command_options.verbose) {
            console.log(`Processing: ${schema_file_path}`);
          }

          const relative_path = relative(path, schema_file_path);
          const entities = extract_entities_from_file(schema_file_path, command_options.verbose);

          if (entities.length > 0) {
            extracted_data[relative_path] = entities;
          }
        }

        // Output the JSON
        const json_output = JSON.stringify(extracted_data, null, 2);

        if (command_options.stdout) {
          // Output to console
          console.log(json_output);
          if (command_options.verbose) {
            const total_entities = Object.values(extracted_data).flat().length;
            console.error(`Extraction completed. ${total_entities} entities found in ${Object.keys(extracted_data).length} files.`);
          }
        } else {
          // Output to file
          writeFileSync(command_options.output, json_output, "utf-8");
          const total_entities = Object.values(extracted_data).flat().length;
          console.log(`Extraction completed. ${total_entities} entities found in ${Object.keys(extracted_data).length} files.`);
          console.log(`Output written to: ${command_options.output}`);
        }
      } catch (error) {
        console.error(`Error: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  return entities_extract_command;
}