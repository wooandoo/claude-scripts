import { readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { Command } from "commander";
import type { DrizzleParsingOptions, EnhancedEntityInfo } from "../lib/drizzle-ast-parser.js";
import { DrizzleASTParser } from "../lib/drizzle-ast-parser.js";

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

async function extract_entities_from_file(
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
            if (relation.type === 'many-to-many' && relation.finalTarget && relation.junctionTable) {
              console.log(`        - ${relation.name}: ${relation.type} → ${relation.finalTarget} (via ${relation.junctionTable})${selfRef}${relationName}`);
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
            console.error('auditColumns value:', entity.auditColumns);
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
    .option("--no-comments", "Exclude comments from extraction")
    .option("--no-analysis", "Skip functional analysis (classification, audit detection)")
    .option("--no-patterns", "Skip pattern analysis")
    .option("--no-relations", "Skip relations extraction")
    .option("--format <format>", "Output format: json, yaml, or markdown", "json")
    .option("--include-metadata", "Include analysis metadata in output")
    .action(async (path, command_options) => {
      try {
        const schema_files = find_schema_files(path, command_options.verbose);

        if (schema_files.length === 0) {
          console.log("No TypeScript files found in the specified path.");
          return;
        }

        // Configure parsing options
        const parsing_options: DrizzleParsingOptions = {
          includeComments: !command_options.noComments,
          analyzePatterns: !command_options.noPatterns,
          classifyEntities: !command_options.noAnalysis,
          detectAuditColumns: !command_options.noAnalysis,
          extractRelations: !command_options.noRelations,
        };

        const extracted_entities: Record<string, EnhancedEntityInfo[]> = {};

        for (const schema_file_path of schema_files) {
          if (command_options.verbose) {
            console.log(`Processing: ${schema_file_path}`);
          }

          let relative_path = relative(path, schema_file_path);
          // If relative path is empty (when path is the same as the file), use the file name
          if (relative_path === '') {
            relative_path = schema_file_path.split('/').pop() || schema_file_path;
          }
          const entities = await extract_entities_from_file(schema_file_path, parsing_options, command_options.verbose);

          if (entities.length > 0) {
            extracted_entities[relative_path] = entities;
          }
        }

        // Prepare output data
        let output_data: ExtractedData | Record<string, EnhancedEntityInfo[]> = extracted_entities;

        if (command_options.includeMetadata) {
          output_data = {
            entities: extracted_entities,
            metadata: analyze_extracted_data(extracted_entities),
          };
        }

        // Format output
        let formatted_output: string;
        switch (command_options.format.toLowerCase()) {
          case "yaml":
            // Simple YAML-like format (would need yaml library for proper YAML)
            formatted_output = JSON.stringify(output_data, null, 2)
              .replace(/"/g, "")
              .replace(/,/g, "")
              .replace(/\{/g, "")
              .replace(/\}/g, "");
            break;
          case "markdown":
            // For markdown format, we need metadata, so create it if not present
            if (command_options.includeMetadata) {
              formatted_output = format_as_markdown(output_data as ExtractedData);
            } else {
              const dataWithMetadata: ExtractedData = {
                entities: output_data as Record<string, EnhancedEntityInfo[]>,
                metadata: analyze_extracted_data(output_data as Record<string, EnhancedEntityInfo[]>),
              };
              formatted_output = format_as_markdown(dataWithMetadata);
            }
            break;
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

          if (command_options.includeMetadata) {
            const metadata = analyze_extracted_data(extracted_entities);
            console.log(
              `Entity types: ${Object.entries(metadata.entityTypes || {})
                .map(([type, count]) => `${type}: ${count}`)
                .join(", ")}`,
            );
            if (metadata.relationStats?.totalRelations > 0) {
              console.log(
                `Relations found: ${metadata.relationStats.totalRelations} total (${Object.entries(metadata.relationStats.relationTypes || {})
                  .map(([type, count]) => `${type}: ${count}`)
                  .join(", ")})`,
              );
              if (metadata.relationStats.selfReferencing > 0) {
                console.log(`Self-referencing relations: ${metadata.relationStats.selfReferencing}`);
              }
            }
            if (metadata.commonPatterns.softDeletes > 0) {
              console.log(`Soft deletes detected: ${metadata.commonPatterns.softDeletes} entities`);
            }
          }
        }
      } catch (error) {
        console.error(`Error: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  return entities_extract_command;
}

function format_as_markdown(data: ExtractedData): string {
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
          if (relation.type === 'many-to-many' && relation.finalTarget && relation.junctionTable) {
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
