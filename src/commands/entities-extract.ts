import { readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { Command } from "commander";
import type { DrizzleParsingOptions, EnhancedEntityInfo } from "../lib/drizzle-ast-parser.js";
import { DrizzleASTParser } from "../lib/drizzle-ast-parser.js";

export function find_schema_files(directory: string, verbose = false): string[] {
  const schema_files: string[] = [];

  function scan_directory(dir: string): void {
    const entries = readdirSync(dir);

    for (const entry of entries) {
      const full_path = join(dir, entry);
      const stat = statSync(full_path);

      if (stat.isDirectory()) {
        scan_directory(full_path);
      } else if (stat.isFile()) {
        // Check for TypeScript files that likely contain Drizzle schema
        if (extname(entry) === ".ts") {
          schema_files.push(full_path);
          if (verbose) {
            console.log(`Found TypeScript file: ${full_path}`);
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

export async function extract_entities_from_file(
  file_path: string,
  options: DrizzleParsingOptions,
  verbose = false,
): Promise<EnhancedEntityInfo[]> {
  try {
    if (verbose) {
      console.log(`Parsing with AST: ${file_path}`);
    }

    const parser = new DrizzleASTParser(options);
    const entities = await parser.parseFile(file_path);

    if (verbose && entities.length > 0) {
      console.log(`  Found ${entities.length} entities:`);
      for (const entity of entities) {
        console.log(`    - ${entity.name} (${entity.tableName}) [${entity.entityType}]`);
        console.log(
          `      Columns: ${entity.columns.length}, PKs: ${entity.primaryKeys.length}, FKs: ${entity.columns.filter((c) => c.references).length}`,
        );
        if (entity.relations && entity.relations.length > 0) {
          console.log(`      Relations: ${entity.relations.length}`);
          for (const relation of entity.relations) {
            const selfRef = relation.isSelfReferencing ? " (self-ref)" : "";
            const relationName = relation.relationName ? ` [${relation.relationName}]` : "";

            // Format many-to-many relations with final target
            if (relation.type === "many-to-many" && relation.finalTarget && relation.junctionTable) {
              console.log(
                `        - ${relation.name}: ${relation.type} → ${relation.finalTarget} (via ${relation.junctionTable})${selfRef}${relationName}`,
              );
            } else {
              console.log(`        - ${relation.name}: ${relation.type} → ${relation.relatedTable}${selfRef}${relationName}`);
            }
          }
        }
        if (entity.auditColumns && Object.keys(entity.auditColumns).length > 0) {
          try {
            const auditFields = Object.entries(entity.auditColumns || {})
              .filter(([_, value]) => value)
              .map(([key, value]) => `${key}: ${value}`)
              .join(", ");
            console.log(`      Audit: ${auditFields}`);
          } catch (error) {
            console.error(`Error processing audit columns for ${entity.name}:`, error);
            console.error("auditColumns value:", entity.auditColumns);
          }
        }
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

interface ExtractedData {
  entities: Record<string, EnhancedEntityInfo[]>;
  metadata: {
    totalEntities: number;
    totalFiles: number;
    entityTypes: Record<string, number>;
    relationStats: {
      totalRelations: number;
      relationTypes: Record<string, number>;
      selfReferencing: number;
      entitiesWithRelations: number;
    };
    commonPatterns: {
      auditColumns: string[];
      softDeletes: number;
      foreignKeys: number;
    };
  };
}

interface NewFormatEntity {
  name: string;
  description: string;
  properties: Record<
    string,
    {
      description: string;
      type: string;
      options: string[];
      default: string;
      typescript_type?: string;
    }
  >;
  primary_keys: string[];
  uniques: string[][];
  relations: Record<
    string,
    {
      target: string;
      target_reference?: Record<string, string>;
      self_reference?: Record<string, string>;
      type: string;
      junction_entity?: string;
      description: string;
      on_delete: string;
    }
  >;
  checks?: string[];
}

interface NewFormatOutput {
  [fileName: string]: any;
  enums?: Record<string, string[]>;
}

type CleanableValue = string | number | boolean | null | undefined | CleanableObject | CleanableValue[];
interface CleanableObject {
  [key: string]: CleanableValue;
}

interface EntityColumn {
  name: string;
  type: string;
  comments?: string;
  defaultValue?: string;
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
  length?: number;
  references?: {
    table: string;
    column: string;
  };
}

interface EntityRelation {
  name: string;
  type: string;
  relatedTable: string;
  isSelfReferencing?: boolean;
  fields?: string[];
  references?: string[];
  junctionTable?: string;
  finalTarget?: string;
  relationName?: string;
}

interface PropertyInfo {
  description?: string;
  type: string;
  options: string[];
  default?: string;
  typescript_type?: string;
}

interface PartialNewFormatEntity {
  name: string;
  description?: string;
  properties?: Record<string, PropertyInfo>;
  primary_keys?: string[];
  uniques?: string[][];
  relations?: Record<string, any>;
  checks?: string[];
}

export function clean_empty_attributes(obj: CleanableValue): CleanableValue {
  if (Array.isArray(obj)) {
    const cleanedArray = obj.map((item) => clean_empty_attributes(item)).filter((item) => item !== null);
    return cleanedArray.length > 0 ? cleanedArray : undefined;
  }

  if (obj !== null && typeof obj === "object") {
    const cleaned: CleanableObject = {};

    for (const [key, value] of Object.entries(obj)) {
      const cleanedValue = clean_empty_attributes(value);

      // Skip empty values but preserve meaningful falsy values like null
      if (
        cleanedValue === undefined ||
        (typeof cleanedValue === "string" && cleanedValue === "") ||
        (Array.isArray(cleanedValue) && cleanedValue.length === 0) ||
        (typeof cleanedValue === "object" && cleanedValue !== null && Object.keys(cleanedValue).length === 0)
      ) {
        continue;
      }

      cleaned[key] = cleanedValue;
    }

    return Object.keys(cleaned).length > 0 ? cleaned : undefined;
  }

  // For primitive types, return undefined if empty string, otherwise return the value
  if (typeof obj === "string" && obj === "") {
    return undefined;
  }

  return obj;
}

export function transform_to_new_format(data: Record<string, EnhancedEntityInfo[]>): NewFormatOutput {
  const result: NewFormatOutput = {
    enums: {}, // TODO: Extract enums from schema analysis
  };

  for (const [fileName, entities] of Object.entries(data)) {
    result[fileName] = {
      entities: entities.map((entity) => transform_entity_to_new_format(entity)),
    };
  }

  // Clean empty attributes before returning
  const cleaned = clean_empty_attributes(result as any);
  return (cleaned as NewFormatOutput) || {};
}

function transform_entity_to_new_format(entity: EnhancedEntityInfo): NewFormatEntity {
  // Transform properties from columns
  const properties: Record<string, PropertyInfo> = {};

  for (const column of entity.columns) {
    const property: PropertyInfo = {
      type: map_column_type_to_new_format(column),
      options: get_column_options(column),
    };

    // Add non-empty attributes only
    if (column.comments) {
      property.description = column.comments;
    }

    if (column.defaultValue) {
      property.default = column.defaultValue;
    }

    if (column.type === "jsonb") {
      // TODO: Extract TS type for JSONB - only add if we have the type
      // property.typescript_type = "";
    }

    properties[column.name] = property;
  }

  // Transform relations from array to object
  const relations: Record<string, any> = {};

  if (entity.relations) {
    for (const relation of entity.relations) {
      relations[relation.name] = transform_relation_to_new_format(relation);
    }
  }

  // Extract unique constraints
  const uniques: string[][] = [];
  for (const column of entity.columns) {
    if (column.unique && !entity.primaryKeys.includes(column.name)) {
      uniques.push([column.name]);
    }
  }

  // Build result object with only non-empty attributes
  const result: any = {
    name: entity.name,
  };

  if (entity.comments) {
    result.description = entity.comments;
  }

  if (Object.keys(properties).length > 0) {
    result.properties = properties;
  }

  if (entity.primaryKeys && entity.primaryKeys.length > 0) {
    result.primary_keys = entity.primaryKeys;
  }

  if (uniques.length > 0) {
    result.uniques = uniques;
  }

  if (Object.keys(relations).length > 0) {
    result.relations = relations;
  }

  if (entity.checks && entity.checks.length > 0) {
    result.checks = entity.checks.map((check: any) => check.constraint || check.toString());
  }

  return result;
}

function map_column_type_to_new_format(column: EntityColumn): string {
  // Map the current column types to the expected format
  if (column.type === "primaryKey") return "integer"; // Assume integer primary key
  if (column.type === "varchar") return `varchar(${column.length || 255})`;
  if (column.type === "integer") return "integer";
  if (column.type === "timestamp") return "timestamp";
  if (column.type === "boolean") return "boolean";
  if (column.type === "defaultNow") return "timestamp";
  if (column.type === "default") return "varchar"; // Default type, may need refinement
  if (column.type === "notNull") return "varchar"; // Default type, may need refinement
  if (column.type === "unique") return "varchar"; // Default type, may need refinement
  if (column.type === "references") return "integer"; // Foreign key, typically integer
  if (column.type === "jsonb") return "jsonb";

  // Try to infer from other properties
  if (column.length) return `varchar(${column.length})`;

  return column.type || "varchar";
}

function get_column_options(column: EntityColumn): string[] {
  const options: string[] = [];

  if (!column.nullable) options.push("not_null");
  // Don't add unique here - it will be in the "uniques" attribute of the entity
  if (column.primaryKey) options.push("primary_key");

  return options;
}

function transform_relation_to_new_format(relation: EntityRelation): any {
  const result: any = {
    target: relation.relatedTable,
    type: determine_correct_relation_type(relation),
  };

  // Add description and on_delete only if they have values
  // TODO: Extract actual values from relation definition
  // if (relation.description) {
  //   result.description = relation.description;
  // }
  // if (relation.onDelete) {
  //   result.on_delete = relation.onDelete;
  // }

  // Handle different relation types
  if (result.type === "many-to-many") {
    if (relation.junctionTable) {
      result.junction_entity = relation.junctionTable;
    }
    if (relation.finalTarget) {
      result.target = relation.finalTarget;
    }

    // For many-to-many, we have references to junction table and from junction to target
    if (relation.fields && relation.references && relation.fields.length > 0 && relation.references.length > 0) {
      const selfRef: Record<string, string> = {};
      for (let i = 0; i < Math.min(relation.fields.length, relation.references.length); i++) {
        if (relation.fields[i] && relation.references[i]) {
          selfRef[relation.fields![i]!] = relation.references![i]!;
        }
      }
      if (Object.keys(selfRef).length > 0) {
        result.self_reference = selfRef;
      }
      // TODO: Add target_reference for junction->target mapping
    }
  } else {
    // For one-to-many and many-to-one relations
    if (relation.fields && relation.references && relation.fields.length > 0 && relation.references.length > 0) {
      if (relation.isSelfReferencing) {
        // Self-referencing relation
        const selfRef: Record<string, string> = {};
        if (result.type === "one-to-many") {
          // Current entity's PK referenced by target entity's FK
          for (let i = 0; i < Math.min(relation.fields.length, relation.references.length); i++) {
            if (relation.references[i] && relation.fields[i]) {
              selfRef[relation.references![i]!] = relation.fields![i]!;
            }
          }
        } else {
          // Many-to-one: current entity's FK -> target's PK
          for (let i = 0; i < Math.min(relation.fields.length, relation.references.length); i++) {
            if (relation.fields[i] && relation.references[i]) {
              selfRef[relation.fields![i]!] = relation.references![i]!;
            }
          }
        }
        if (Object.keys(selfRef).length > 0) {
          result.self_reference = selfRef;
        }
      } else {
        // Regular relation between different entities
        const targetRef: Record<string, string> = {};
        if (result.type === "one-to-many") {
          // Current entity's PK referenced by target entity's FK
          for (let i = 0; i < Math.min(relation.fields.length, relation.references.length); i++) {
            if (relation.references[i] && relation.fields[i]) {
              targetRef[relation.references![i]!] = relation.fields![i]!;
            }
          }
        } else {
          // Many-to-one: current entity's FK -> target's PK
          for (let i = 0; i < Math.min(relation.fields.length, relation.references.length); i++) {
            if (relation.fields[i] && relation.references[i]) {
              targetRef[relation.fields![i]!] = relation.references![i]!;
            }
          }
        }
        if (Object.keys(targetRef).length > 0) {
          result.target_reference = targetRef;
        }
      }
    }
  }

  return result;
}

function determine_correct_relation_type(relation: EntityRelation): string {
  // Keep many-to-many as is
  if (relation.type === "many-to-many") {
    return "many-to-many";
  }

  // For one-to-many relations in Drizzle, we need to determine the correct perspective
  if (relation.type === "one-to-many") {
    // If the current entity has fields pointing to the target, it's actually many-to-one
    // (current entity has FK -> target's PK)
    if (relation.fields && relation.fields.length > 0) {
      return "many-to-one";
    }
    // If no fields specified, it's truly one-to-many (current entity's PK is referenced by target's FK)
    return "one-to-many";
  }

  return relation.type;
}

function analyze_extracted_data(data: Record<string, EnhancedEntityInfo[]>): ExtractedData["metadata"] {
  const allEntities = Object.values(data).flat();
  const entityTypes: Record<string, number> = {};
  const auditColumnsSet = new Set<string>();
  let softDeletes = 0;
  let foreignKeys = 0;

  // Relations statistics
  const relationTypes: Record<string, number> = {};
  let totalRelations = 0;
  let selfReferencing = 0;
  let entitiesWithRelations = 0;

  for (const entity of allEntities) {
    // Count entity types
    if (entity.entityType) {
      entityTypes[entity.entityType] = (entityTypes[entity.entityType] || 0) + 1;
    }

    // Collect audit columns
    if (entity.auditColumns) {
      Object.values(entity.auditColumns || {}).forEach((col) => {
        if (col) auditColumnsSet.add(col);
      });
      if (entity.auditColumns.deletedAt) softDeletes++;
    }

    // Count foreign keys
    foreignKeys += entity.columns.filter((col) => col.references).length;

    // Count relations
    if (entity.relations && entity.relations.length > 0) {
      entitiesWithRelations++;
      totalRelations += entity.relations.length;

      for (const relation of entity.relations) {
        relationTypes[relation.type] = (relationTypes[relation.type] || 0) + 1;
        if (relation.isSelfReferencing) {
          selfReferencing++;
        }
      }
    }
  }

  return {
    totalEntities: allEntities.length,
    totalFiles: Object.keys(data).length,
    entityTypes,
    relationStats: {
      totalRelations,
      relationTypes,
      selfReferencing,
      entitiesWithRelations,
    },
    commonPatterns: {
      auditColumns: Array.from(auditColumnsSet),
      softDeletes,
      foreignKeys,
    },
  };
}

export function entitiesExtract(): Command {
  const entities_extract_command = new Command("entities:extract");

  entities_extract_command
    .description("Extract entity information from Drizzle schema files using AST analysis")
    .argument("<path>", "Path to schema file or directory containing schema files")
    .option("-o, --output <file>", "Output JSON file path", "entities.json")
    .option("--stdout", "Output to console instead of file")
    .option("-v, --verbose", "Enable verbose output")
    .option("--format <format>", "Output format: json, yaml, or markdown", "json")
    .action(async (path, command_options) => {
      try {
        const schema_files = find_schema_files(path, command_options.verbose);

        if (schema_files.length === 0) {
          console.log("No TypeScript files found in the specified path.");
          return;
        }

        // Configure parsing options
        const parsing_options: DrizzleParsingOptions = {
          includeComments: true,
          analyzePatterns: true,
          classifyEntities: true,
          detectAuditColumns: true,
          extractRelations: true,
        };

        const extracted_entities: Record<string, EnhancedEntityInfo[]> = {};

        for (const schema_file_path of schema_files) {
          if (command_options.verbose) {
            console.log(`Processing: ${schema_file_path}`);
          }

          let relative_path = relative(path, schema_file_path);
          // If relative path is empty (when path is the same as the file), use the file name
          if (relative_path === "") {
            relative_path = schema_file_path.split("/").pop() || schema_file_path;
          }
          const entities = await extract_entities_from_file(schema_file_path, parsing_options, command_options.verbose);

          if (entities.length > 0) {
            extracted_entities[relative_path] = entities;
          }
        }

        // Transform to new format
        const output_data = transform_to_new_format(extracted_entities);

        // Format output
        let formatted_output: string;
        switch (command_options.format.toLowerCase()) {
          case "yaml":
            formatted_output = format_as_yaml(output_data);
            break;
          case "markdown": {
            const dataWithMetadata = {
              ...output_data,
              metadata: analyze_extracted_data(extracted_entities),
            } as NewFormatOutput & { metadata: ExtractedData["metadata"] };
            formatted_output = format_as_markdown_new_format(dataWithMetadata);
            break;
          }
          default:
            formatted_output = JSON.stringify(output_data, null, 2);
        }

        if (command_options.stdout) {
          // Output to console
          console.log(formatted_output);
          if (command_options.verbose) {
            const total_entities = Object.values(extracted_entities).flat().length;
            console.error(`Extraction completed. ${total_entities} entities found in ${Object.keys(extracted_entities).length} files.`);
          }
        } else {
          // Output to file
          writeFileSync(command_options.output, formatted_output, "utf-8");
          const total_entities = Object.values(extracted_entities).flat().length;
          console.log(`Extraction completed. ${total_entities} entities found in ${Object.keys(extracted_entities).length} files.`);
          console.log(`Output written to: ${command_options.output}`);
        }
      } catch (error) {
        console.error(`Error: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  return entities_extract_command;
}

export function format_as_yaml(data: NewFormatOutput): string {
  let yaml = "";

  // Handle enums first
  if (data.enums && Object.keys(data.enums).length > 0) {
    yaml += "enums:\n";
    for (const [enumName, values] of Object.entries(data.enums)) {
      yaml += `  ${enumName}:\n`;
      for (const value of values as string[]) {
        yaml += `    - "${value}"\n`;
      }
    }
    yaml += "\n";
  } else {
    yaml += "enums: {}\n\n";
  }

  // Handle entities
  for (const [fileName, fileData] of Object.entries(data)) {
    if (fileName === "enums") continue;

    const entities = (fileData as { entities: NewFormatEntity[] }).entities;
    if (!entities) continue;

    yaml += `"${fileName}":\n`;
    yaml += `  entities:\n`;

    for (const entity of entities) {
      yaml += `    - name: "${entity.name}"\n`;
      yaml += `      description: "${entity.description}"\n`;

      // Properties
      yaml += `      properties:\n`;
      for (const [propName, prop] of Object.entries(entity.properties)) {
        yaml += `        ${propName}:\n`;
        const typedProp = prop as PropertyInfo;
        yaml += `          description: "${typedProp.description || ""}"\n`;
        yaml += `          type: "${typedProp.type}"\n`;
        if (typedProp.options && typedProp.options.length > 0) {
          yaml += `          options:\n`;
          for (const option of typedProp.options) {
            yaml += `            - "${option}"\n`;
          }
        }
        yaml += `          default: "${typedProp.default || ""}"\n`;
        if (typedProp.typescript_type) {
          yaml += `          typescript_type: "${typedProp.typescript_type}"\n`;
        }
      }

      // Primary keys
      if (entity.primary_keys && entity.primary_keys.length > 0) {
        yaml += `      primary_keys:\n`;
        for (const pk of entity.primary_keys) {
          yaml += `        - "${pk}"\n`;
        }
      }

      // Uniques
      if (entity.uniques && entity.uniques.length > 0) {
        yaml += `      uniques:\n`;
        for (const unique of entity.uniques) {
          yaml += `        -\n`;
          for (const col of unique) {
            yaml += `          - "${col}"\n`;
          }
        }
      }

      // Relations
      yaml += `      relations:\n`;
      for (const [relationName, relation] of Object.entries(entity.relations)) {
        const rel = relation as Record<string, unknown>;
        yaml += `        ${relationName}:\n`;
        yaml += `          target: "${rel.target}"\n`;
        yaml += `          type: "${rel.type}"\n`;
        yaml += `          description: "${rel.description}"\n`;
        yaml += `          on_delete: "${rel.on_delete}"\n`;

        if (rel.junction_entity) {
          yaml += `          junction_entity: "${rel.junction_entity}"\n`;
        }

        if (rel.target_reference) {
          yaml += `          target_reference:\n`;
          for (const [key, value] of Object.entries(rel.target_reference)) {
            yaml += `            ${key}: "${value}"\n`;
          }
        }

        if (rel.self_reference) {
          yaml += `          self_reference:\n`;
          for (const [key, value] of Object.entries(rel.self_reference)) {
            yaml += `            ${key}: "${value}"\n`;
          }
        }
      }

      // Checks
      yaml += `      checks:\n`;
      for (const check of entity.checks || []) {
        yaml += `        - "${check}"\n`;
      }

      yaml += "\n";
    }
  }

  return yaml;
}

export function format_as_markdown_new_format(data: NewFormatOutput & { metadata?: ExtractedData["metadata"] }): string {
  let markdown = "# Drizzle Schema Analysis\n\n";

  // Metadata section
  if (data.metadata) {
    markdown += "## Summary\n\n";
    markdown += `- **Total Entities**: ${data.metadata.totalEntities}\n`;
    markdown += `- **Total Files**: ${data.metadata.totalFiles}\n`;
    markdown += `- **Total Relations**: ${data.metadata.relationStats.totalRelations}\n`;
    markdown += `- **Entities with Relations**: ${data.metadata.relationStats.entitiesWithRelations}\n`;
    markdown += `- **Foreign Keys**: ${data.metadata.commonPatterns.foreignKeys}\n`;
    if (data.metadata.commonPatterns.softDeletes > 0) {
      markdown += `- **Soft Deletes**: ${data.metadata.commonPatterns.softDeletes}\n`;
    }
    if (data.metadata.relationStats.selfReferencing > 0) {
      markdown += `- **Self-Referencing Relations**: ${data.metadata.relationStats.selfReferencing}\n`;
    }
    markdown += "\n";

    // Entity types breakdown
    if (data.metadata.entityTypes && Object.keys(data.metadata.entityTypes).length > 0) {
      markdown += "## Entity Types\n\n";
      for (const [type, count] of Object.entries(data.metadata.entityTypes)) {
        markdown += `- **${type}**: ${count}\n`;
      }
      markdown += "\n";
    }

    // Relation types breakdown
    if (data.metadata.relationStats?.relationTypes && Object.keys(data.metadata.relationStats.relationTypes).length > 0) {
      markdown += "## Relation Types\n\n";
      for (const [type, count] of Object.entries(data.metadata.relationStats.relationTypes)) {
        markdown += `- **${type}**: ${count}\n`;
      }
      markdown += "\n";
    }
  }

  // Enums section
  if (data.enums && Object.keys(data.enums).length > 0) {
    markdown += "## Enums\n\n";
    for (const [enumName, values] of Object.entries(data.enums)) {
      markdown += `### ${enumName}\n\n`;
      for (const value of values as string[]) {
        markdown += `- ${value}\n`;
      }
      markdown += "\n";
    }
  }

  // Entities section
  markdown += "## Entities\n\n";

  for (const [file, fileData] of Object.entries(data)) {
    if (file === "metadata" || file === "enums") continue;

    const entities = (fileData as { entities: NewFormatEntity[] }).entities;
    if (!entities) continue;

    markdown += `### ${file}\n\n`;

    for (const entity of entities) {
      markdown += `#### ${entity.name}\n\n`;

      if (entity.description) {
        markdown += `${entity.description}\n\n`;
      }

      markdown += `- **Primary Keys**: ${entity.primary_keys && entity.primary_keys.length > 0 ? entity.primary_keys.join(", ") : "none"}\n`;

      if (entity.uniques && entity.uniques.length > 0) {
        markdown += `- **Unique Constraints**: ${entity.uniques.map((u: string[]) => u.join(", ")).join("; ")}\n`;
      }

      // Properties
      if (Object.keys(entity.properties).length > 0) {
        markdown += `- **Properties**:\n`;
        for (const [propName, prop] of Object.entries(entity.properties)) {
          const typedProp = prop as PropertyInfo;
          const options = typedProp.options && typedProp.options.length > 0 ? ` (${typedProp.options.join(", ")})` : "";
          const defaultVal = typedProp.default ? ` [default: ${typedProp.default}]` : "";
          const description = typedProp.description ? ` - ${typedProp.description}` : "";
          markdown += `  - **${propName}**: ${typedProp.type}${options}${defaultVal}${description}\n`;
        }
      }

      // Relations
      if (Object.keys(entity.relations).length > 0) {
        markdown += `- **Relations** (${Object.keys(entity.relations).length}):\n`;
        for (const [relationName, relation] of Object.entries(entity.relations)) {
          const rel = relation as Record<string, unknown>;
          let relationInfo = `${rel.type} → **${rel.target}**`;

          if (rel.junction_entity) {
            relationInfo += ` _(via ${rel.junction_entity})_`;
          }

          if (rel.target_reference || rel.self_reference) {
            const refs = (rel.target_reference || rel.self_reference) as Record<string, unknown>;
            const refStr = Object.entries(refs)
              .map(([k, v]) => `${k}:${v}`)
              .join(", ");
            relationInfo += ` (${refStr})`;
          }

          markdown += `  - **${relationName}**: ${relationInfo}\n`;
        }
      }

      if (entity.checks && entity.checks.length > 0) {
        markdown += `- **Checks**: ${entity.checks.join(", ")}\n`;
      }

      markdown += "\n";
    }
  }

  return markdown;
}

function _format_as_markdown(data: ExtractedData): string {
  let markdown = "# Drizzle Schema Analysis\n\n";

  // Metadata section
  if (data.metadata) {
    markdown += "## Summary\n\n";
    markdown += `- **Total Entities**: ${data.metadata.totalEntities}\n`;
    markdown += `- **Total Files**: ${data.metadata.totalFiles}\n`;
    markdown += `- **Total Relations**: ${data.metadata.relationStats.totalRelations}\n`;
    markdown += `- **Entities with Relations**: ${data.metadata.relationStats.entitiesWithRelations}\n`;
    markdown += `- **Foreign Keys**: ${data.metadata.commonPatterns.foreignKeys}\n`;
    if (data.metadata.commonPatterns.softDeletes > 0) {
      markdown += `- **Soft Deletes**: ${data.metadata.commonPatterns.softDeletes}\n`;
    }
    if (data.metadata.relationStats.selfReferencing > 0) {
      markdown += `- **Self-Referencing Relations**: ${data.metadata.relationStats.selfReferencing}\n`;
    }
    markdown += "\n";

    // Entity types breakdown
    if (data.metadata.entityTypes && Object.keys(data.metadata.entityTypes).length > 0) {
      markdown += "## Entity Types\n\n";
      for (const [type, count] of Object.entries(data.metadata.entityTypes)) {
        markdown += `- **${type}**: ${count}\n`;
      }
      markdown += "\n";
    }

    // Relation types breakdown
    if (data.metadata.relationStats?.relationTypes && Object.keys(data.metadata.relationStats.relationTypes).length > 0) {
      markdown += "## Relation Types\n\n";
      for (const [type, count] of Object.entries(data.metadata.relationStats.relationTypes)) {
        markdown += `- **${type}**: ${count}\n`;
      }
      markdown += "\n";
    }
  }

  // Entities section
  markdown += "## Entities\n\n";

  for (const [file, entities] of Object.entries(data.entities || {})) {
    markdown += `### ${file}\n\n`;

    for (const entity of entities) {
      markdown += `#### ${entity.name} → \`${entity.tableName}\`\n\n`;
      markdown += `- **Type**: ${entity.entityType || "unknown"}\n`;
      markdown += `- **Columns**: ${entity.columns.length}\n`;
      markdown += `- **Primary Keys**: ${entity.primaryKeys.join(", ") || "none"}\n`;

      const fkColumns = entity.columns.filter((col) => col.references);
      if (fkColumns.length > 0) {
        markdown += `- **Foreign Keys**: ${fkColumns.map((col) => `${col.name} → ${col.references?.table}.${col.references?.column}`).join(", ")}\n`;
      }

      if (entity.relations && entity.relations.length > 0) {
        markdown += `- **Relations** (${entity.relations.length}):\n`;
        for (const relation of entity.relations) {
          const selfRef = relation.isSelfReferencing ? " _(self-referencing)_" : "";
          const relationName = relation.relationName ? ` \`[${relation.relationName}]\`` : "";
          const fields = relation.fields ? ` (${relation.fields.join(", ")})` : "";

          // Format many-to-many relations with final target
          if (relation.type === "many-to-many" && relation.finalTarget && relation.junctionTable) {
            markdown += `  - **${relation.name}**: ${relation.type} → **${relation.finalTarget}** _(via ${relation.junctionTable})_${fields}${selfRef}${relationName}\n`;
          } else {
            markdown += `  - **${relation.name}**: ${relation.type} → ${relation.relatedTable}${fields}${selfRef}${relationName}\n`;
          }
        }
      }

      if (entity.auditColumns && Object.keys(entity.auditColumns).length > 0) {
        const auditInfo = Object.entries(entity.auditColumns || {})
          .filter(([_, value]) => value)
          .map(([key, value]) => `${key}: ${value}`)
          .join(", ");
        markdown += `- **Audit Columns**: ${auditInfo}\n`;
      }

      if (entity.comments) {
        markdown += `- **Comments**: ${entity.comments}\n`;
      }

      markdown += "\n";
    }
  }

  return markdown;
}
