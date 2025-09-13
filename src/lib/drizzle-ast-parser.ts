import {
  type CallExpression,
  Node,
  type ObjectLiteralExpression,
  Project,
  type PropertyAssignment,
  type VariableDeclaration,
} from "ts-morph";

// Enhanced interfaces for enriched entity information
export interface EnhancedEntityInfo {
  name: string;
  tableName: string;
  columns: EnhancedColumnInfo[];
  primaryKeys: string[];
  foreignKeys: EnhancedForeignKeyInfo[];
  indexes: EnhancedIndexInfo[];
  checks: EnhancedCheckInfo[];
  relations?: EnhancedRelationInfo[];
  comments?: string;
  schema?: string;
  entityType?: "reference" | "transactional" | "association" | "audit" | "transactional-many-to-many";
  auditColumns?: AuditColumnInfo;
}

export interface EnhancedColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue?: string;
  primaryKey: boolean;
  unique: boolean;
  length?: number;
  precision?: number;
  scale?: number;
  enumValues?: string[];
  references?: {
    table: string;
    column: string;
    onDelete?: "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION";
    onUpdate?: "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION";
  };
  comments?: string;
  pattern?: string;
}

export interface EnhancedForeignKeyInfo {
  columns: string[];
  references: {
    table: string;
    columns: string[];
  };
  onDelete?: "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION";
  onUpdate?: "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION";
  name?: string;
}

export interface EnhancedIndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  partial?: boolean;
  condition?: string;
  type?: "btree" | "hash" | "gin" | "gist";
}

export interface EnhancedCheckInfo {
  name: string;
  expression: string;
  columns: string[];
}

export interface AuditColumnInfo {
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string;
  version?: string;
}

export interface EnhancedRelationInfo {
  name: string;
  type: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
  relatedTable: string;
  fields?: string[];
  references?: string[];
  relationName?: string;
  isJunctionTable?: boolean;
  isSelfReferencing?: boolean;
  // For many-to-many relations, store the final target table and junction table
  finalTarget?: string;
  junctionTable?: string;
}

export interface DrizzleParsingOptions {
  includeComments?: boolean;
  analyzePatterns?: boolean;
  classifyEntities?: boolean;
  detectAuditColumns?: boolean;
  extractRelations?: boolean;
}

export class DrizzleASTParser {
  private project: Project;
  private options: DrizzleParsingOptions;

  constructor(options: DrizzleParsingOptions = {}) {
    this.project = new Project();
    this.options = {
      includeComments: true,
      analyzePatterns: true,
      classifyEntities: true,
      detectAuditColumns: true,
      extractRelations: true,
      ...options,
    };
  }

  async parseFile(filePath: string): Promise<EnhancedEntityInfo[]> {
    const sourceFile = this.project.addSourceFileAtPath(filePath);
    const entities: EnhancedEntityInfo[] = [];
    const relations: Map<string, EnhancedRelationInfo[]> = new Map();

    // Find all exported variable declarations that could be Drizzle tables
    const tableDeclarations = sourceFile
      .getVariableDeclarations()
      .filter((decl) => decl.hasExportKeyword())
      .filter((decl) => this.isTableDeclaration(decl));

    for (const decl of tableDeclarations) {
      const entity = await this.parseTableDeclaration(decl);
      if (entity) {
        entities.push(entity);
      }
    }

    // Extract relations if enabled
    if (this.options.extractRelations) {
      const relationDeclarations = sourceFile
        .getVariableDeclarations()
        .filter((decl) => decl.hasExportKeyword())
        .filter((decl) => this.isRelationDeclaration(decl));

      for (const decl of relationDeclarations) {
        const entityRelations = await this.parseRelationDeclaration(decl);
        if (entityRelations) {
          const tableName = this.getTableNameFromRelationDeclaration(decl);
          if (tableName) {
            relations.set(tableName, entityRelations);
          }
        }
      }

      // Associate relations with entities
      for (const entity of entities) {
        const entityRelations = relations.get(entity.name);
        if (entityRelations) {
          entity.relations = entityRelations;
        }
      }

      // Resolve many-to-many relations
      this.resolveManyToManyRelations(entities);
    }

    this.project.removeSourceFile(sourceFile);
    return entities;
  }

  private isTableDeclaration(decl: VariableDeclaration): boolean {
    const initializer = decl.getInitializer();
    if (!initializer || !Node.isCallExpression(initializer)) {
      return false;
    }

    const expression = initializer.getExpression().getText();
    return expression.includes("Table") && (expression.includes("pg") || expression.includes("mysql") || expression.includes("sqlite"));
  }

  private async parseTableDeclaration(decl: VariableDeclaration): Promise<EnhancedEntityInfo | null> {
    const initializer = decl.getInitializer();
    if (!initializer || !Node.isCallExpression(initializer)) {
      return null;
    }

    const callExpression = initializer as CallExpression;
    const args = callExpression.getArguments();

    if (args.length < 2) {
      return null;
    }

    // Extract table name (first argument)
    const tableNameArg = args[0];
    if (!tableNameArg) {
      return null;
    }
    const tableName = this.extractStringValue(tableNameArg);

    if (!tableName) {
      return null;
    }

    // Extract columns (second argument - object literal)
    const columnsArg = args[1];
    if (!Node.isObjectLiteralExpression(columnsArg)) {
      return null;
    }

    const entity: EnhancedEntityInfo = {
      name: decl.getName(),
      tableName: tableName,
      columns: await this.parseColumns(columnsArg),
      primaryKeys: [],
      foreignKeys: [],
      indexes: [],
      checks: [],
    };

    // Extract comments if enabled - look at the parent variable statement
    if (this.options.includeComments) {
      const variableStatement = decl.getVariableStatement();
      if (variableStatement) {
        entity.comments = this.extractComments(variableStatement);
      }
      // Fallback to declaration itself if no statement comments
      if (!entity.comments) {
        entity.comments = this.extractComments(decl);
      }
    }

    // Analyze and classify entity
    if (this.options.classifyEntities) {
      entity.entityType = this.classifyEntity(entity);
    }

    // Detect audit columns
    if (this.options.detectAuditColumns) {
      entity.auditColumns = this.detectAuditColumns(entity.columns);
    }

    // Extract primary keys
    entity.primaryKeys = entity.columns.filter((col) => col.primaryKey).map((col) => col.name);

    return entity;
  }

  private async parseColumns(objectLiteral: ObjectLiteralExpression): Promise<EnhancedColumnInfo[]> {
    const columns: EnhancedColumnInfo[] = [];
    const properties = objectLiteral.getProperties();

    for (const prop of properties) {
      if (Node.isPropertyAssignment(prop)) {
        const column = await this.parseColumn(prop as PropertyAssignment);
        if (column) {
          columns.push(column);
        }
      }
    }

    return columns;
  }

  private async parseColumn(prop: PropertyAssignment): Promise<EnhancedColumnInfo | null> {
    const columnName = prop.getName();
    if (!columnName) {
      return null;
    }

    const initializer = prop.getInitializer();
    if (!initializer || !Node.isCallExpression(initializer)) {
      return null;
    }

    const column: EnhancedColumnInfo = {
      name: columnName,
      type: "unknown",
      nullable: true, // Default assumption
      primaryKey: false,
      unique: false,
    };

    // Parse the column type and its parameters
    await this.parseColumnType(initializer as CallExpression, column);

    // Parse chained method calls (.notNull(), .primaryKey(), etc.)
    await this.parseColumnMethods(initializer as CallExpression, column);

    // Extract comments if enabled
    if (this.options.includeComments) {
      column.comments = this.extractComments(prop);
    }

    return column;
  }

  private async parseColumnType(callExpr: CallExpression, column: EnhancedColumnInfo): Promise<void> {
    const expression = callExpr.getExpression();

    // Extract base type
    if (Node.isIdentifier(expression)) {
      column.type = expression.getText();
    } else if (Node.isPropertyAccessExpression(expression)) {
      column.type = expression.getName();
    }

    // Parse type parameters
    const args = callExpr.getArguments();
    if (args.length > 0) {
      // First argument might be column name in database
      if (args.length > 1) {
        // Second argument might be options object
        const optionsArg = args[1];
        if (Node.isObjectLiteralExpression(optionsArg)) {
          await this.parseTypeOptions(optionsArg, column);
        }
      }
    }
  }

  private async parseTypeOptions(objectLiteral: ObjectLiteralExpression, column: EnhancedColumnInfo): Promise<void> {
    const properties = objectLiteral.getProperties();

    for (const prop of properties) {
      if (Node.isPropertyAssignment(prop)) {
        const propName = prop.getName();
        const value = prop.getInitializer();

        if (!propName || !value) continue;

        switch (propName) {
          case "length":
            column.length = this.extractNumericValue(value);
            break;
          case "precision":
            column.precision = this.extractNumericValue(value);
            break;
          case "scale":
            column.scale = this.extractNumericValue(value);
            break;
          case "enum":
            if (Node.isArrayLiteralExpression(value)) {
              column.enumValues = value
                .getElements()
                .map((el) => this.extractStringValue(el))
                .filter((val) => val !== null) as string[];
            }
            break;
        }
      }
    }
  }

  private async parseColumnMethods(initialCallExpr: CallExpression, column: EnhancedColumnInfo): Promise<void> {
    // Start from the property assignment and walk up to find the full chain
    const propertyAssignment = initialCallExpr.getFirstAncestor(n => Node.isPropertyAssignment(n));
    if (!propertyAssignment) return;

    const initializer = propertyAssignment.getInitializer();
    if (!initializer || !Node.isCallExpression(initializer)) return;

    // This initializer is the full method chain
    this.parseMethodChain(initializer, column);
  }

  private parseMethodChain(expr: CallExpression, column: EnhancedColumnInfo): void {
    const methodName = this.getMethodName(expr);
    if (!methodName) return;

    // Apply the method to the column
    switch (methodName) {
      case "notNull":
        column.nullable = false;
        break;
      case "primaryKey":
        column.primaryKey = true;
        break;
      case "unique":
        column.unique = true;
        break;
      case "default": {
        const args = expr.getArguments();
        if (args.length > 0 && args[0]) {
          column.defaultValue = this.extractValue(args[0]);
        }
        break;
      }
      case "defaultNow":
        column.defaultValue = "NOW()";
        break;
      case "references":
        this.parseReferences(expr).then(ref => {
          if (ref) column.references = ref;
        });
        break;
    }

    // Continue parsing the chained expression
    const chainedExpr = expr.getExpression();
    if (Node.isCallExpression(chainedExpr)) {
      this.parseMethodChain(chainedExpr, column);
    }
  }

  private async parseReferences(callExpr: CallExpression): Promise<EnhancedColumnInfo["references"] | undefined> {
    const args = callExpr.getArguments();
    if (args.length === 0) {
      return undefined;
    }

    const arg = args[0];
    if (Node.isArrowFunction(arg)) {
      const body = arg.getBody();
      if (Node.isPropertyAccessExpression(body)) {
        const object = body.getExpression();
        const property = body.getName();

        if (Node.isIdentifier(object)) {
          return {
            table: object.getText(),
            column: property,
          };
        }
      }
    }

    return undefined;
  }

  private getMethodName(callExpr: CallExpression): string | undefined {
    const expression = callExpr.getExpression();
    if (Node.isPropertyAccessExpression(expression)) {
      return expression.getName();
    }
    return undefined;
  }

  private extractStringValue(node: Node): string | null {
    if (Node.isStringLiteral(node)) {
      return node.getLiteralValue();
    }
    if (Node.isNoSubstitutionTemplateLiteral(node)) {
      return node.getLiteralValue();
    }
    return null;
  }

  private extractNumericValue(node: Node): number | undefined {
    if (Node.isNumericLiteral(node)) {
      return node.getLiteralValue();
    }
    return undefined;
  }

  private extractValue(node: Node): string | undefined {
    if (Node.isStringLiteral(node)) {
      return node.getLiteralValue();
    }
    if (Node.isNumericLiteral(node)) {
      return node.getLiteralValue().toString();
    }
    if (Node.isTrueLiteral(node) || Node.isFalseLiteral(node)) {
      return node.getText();
    }
    if (Node.isIdentifier(node)) {
      return node.getText();
    }
    return node.getText();
  }

  private extractComments(node: Node): string | undefined {
    const leadingComments = node.getLeadingCommentRanges();

    if (leadingComments.length > 0) {
      return leadingComments
        .map((comment) => {
          const text = comment.getText();
          let lines: string[] = [];
          
          // Handle JSDoc comments (/** ... */)
          if (text.startsWith("/**")) {
            lines = text
              .replace(/\/\*\*|\*\//g, "")
              .split("\n")
              .map((line) => line.replace(/^\s*\*\s?/, ""));
          }
          // Handle block comments (/* ... */)
          else if (text.startsWith("/*")) {
            lines = text
              .replace(/\/\*|\*\//g, "")
              .split("\n")
              .map((line) => line.replace(/^\s*\*?\s?/, ""));
          }
          // Handle single line comments (//)
          else {
            lines = [text.replace(/\/\//g, "")];
          }
          
          // Process lines: trim each line
          const processedLines = lines.map(line => line.trim());
          
          // Remove leading and trailing empty lines
          while (processedLines.length > 0 && processedLines[0] === '') {
            processedLines.shift();
          }
          while (processedLines.length > 0 && processedLines[processedLines.length - 1] === '') {
            processedLines.pop();
          }
          
          if (processedLines.length === 0) return '';
          
          // Group consecutive non-empty lines, with empty lines creating breaks
          const paragraphs: string[] = [];
          let currentParagraph: string[] = [];
          
          for (const line of processedLines) {
            if (line === '') {
              // Empty line - finish current paragraph if it has content
              if (currentParagraph.length > 0) {
                paragraphs.push(currentParagraph.join(' '));
                currentParagraph = [];
              }
            } else {
              // Non-empty line - add to current paragraph
              currentParagraph.push(line);
            }
          }
          
          // Add final paragraph if it exists
          if (currentParagraph.length > 0) {
            paragraphs.push(currentParagraph.join(' '));
          }
          
          // Join paragraphs with single \n
          return paragraphs.join('\n');
        })
        .filter((comment) => comment.length > 0)
        .join('\n');
    }

    return undefined;
  }

  private classifyEntity(entity: EnhancedEntityInfo): EnhancedEntityInfo["entityType"] {
    const name = entity.name.toLowerCase();
    const tableName = entity.tableName.toLowerCase();

    // Many-to-many junction tables (transactional-many-to-many)
    // Look for tables with "To" in the name or typical junction table patterns
    const foreignKeyCount = entity.columns.filter((col) => col.references).length;
    const hasJunctionPattern = name.includes("to") || name.includes("_to_") || 
                              tableName.includes("_to_") || tableName.includes("to");
    
    // Also detect by having multiple ID columns that are likely foreign keys
    const idColumns = entity.columns.filter((col) => 
      col.name.toLowerCase().endsWith("id") && 
      col.name.toLowerCase() !== "id"
    );
    
    if (
      (hasJunctionPattern || idColumns.length >= 2) && 
      entity.columns.length <= 6 && // Usually junction tables are small
      !entity.primaryKeys.length // Most junction tables don't have their own primary key
    ) {
      return "transactional-many-to-many";
    }

    // Association/junction tables (general)
    if (foreignKeyCount >= 2) {
      return "association";
    }

    // Audit/log tables
    if (name.includes("log") || name.includes("audit") || name.includes("history")) {
      return "audit";
    }

    // Reference/lookup tables
    const hasOnlyIdAndName =
      entity.columns.length <= 4 && entity.columns.some((col) => col.name.includes("name") || col.name.includes("title"));
    if (hasOnlyIdAndName || name.includes("type") || name.includes("status") || name.includes("category")) {
      return "reference";
    }

    // Default to transactional
    return "transactional";
  }

  private detectAuditColumns(columns: EnhancedColumnInfo[]): AuditColumnInfo {
    const audit: AuditColumnInfo = {};

    for (const col of columns) {
      const name = col.name.toLowerCase();
      if (name.includes("created") && name.includes("at")) {
        audit.createdAt = col.name;
      } else if (name.includes("updated") && name.includes("at")) {
        audit.updatedAt = col.name;
      } else if (name.includes("deleted") && name.includes("at")) {
        audit.deletedAt = col.name;
      } else if (name === "version" || name === "_version") {
        audit.version = col.name;
      }
    }

    return audit;
  }

  private isRelationDeclaration(decl: VariableDeclaration): boolean {
    const initializer = decl.getInitializer();
    if (!initializer || !Node.isCallExpression(initializer)) {
      return false;
    }

    const expression = initializer.getExpression().getText();
    return expression === "relations";
  }

  private getTableNameFromRelationDeclaration(decl: VariableDeclaration): string | null {
    const declName = decl.getName();
    if (!declName) return null;
    // Convert "usersRelations" to "users", "postsRelations" to "posts", etc.
    const match = declName.match(/^(.+)Relations$/);
    return match?.[1] ?? null;
  }

  private async parseRelationDeclaration(decl: VariableDeclaration): Promise<EnhancedRelationInfo[] | null> {
    const initializer = decl.getInitializer();
    if (!initializer || !Node.isCallExpression(initializer)) {
      return null;
    }

    const callExpression = initializer as CallExpression;
    const args = callExpression.getArguments();

    if (args.length < 2) {
      return null;
    }

    // Second argument should be the relations function
    const relationsArg = args[1];
    if (!relationsArg || (!Node.isArrowFunction(relationsArg) && !Node.isFunctionExpression(relationsArg))) {
      return null;
    }

    const relations: EnhancedRelationInfo[] = [];

    // Get the function body (should be an object literal or return statement)
    const body = relationsArg.getBody();
    let objectLiteral: ObjectLiteralExpression | undefined;

    if (Node.isObjectLiteralExpression(body)) {
      objectLiteral = body;
    } else if (Node.isBlock(body)) {
      const returnStatement = body.getStatements().find((stmt) => Node.isReturnStatement(stmt));
      if (returnStatement && Node.isReturnStatement(returnStatement)) {
        const returnExpression = returnStatement.getExpression();
        if (returnExpression && Node.isObjectLiteralExpression(returnExpression)) {
          objectLiteral = returnExpression;
        }
      }
    } else if (Node.isParenthesizedExpression(body)) {
      const inner = body.getExpression();
      if (Node.isObjectLiteralExpression(inner)) {
        objectLiteral = inner;
      }
    }

    if (!objectLiteral) {
      return null;
    }

    // Parse each relation property
    const properties = objectLiteral.getProperties();
    
    for (const prop of properties) {
      if (Node.isPropertyAssignment(prop)) {
        const relation = this.parseRelationProperty(prop as PropertyAssignment);
        if (relation) {
          relations.push(relation);
        }
      }
    }

    return relations.length > 0 ? relations : null;
  }

  private parseRelationProperty(prop: PropertyAssignment): EnhancedRelationInfo | null {
    const name = prop.getName();
    if (!name) return null;

    const initializer = prop.getInitializer();
    if (!initializer || !Node.isCallExpression(initializer)) {
      return null;
    }

    const callExpression = initializer as CallExpression;
    const expression = callExpression.getExpression().getText();

    let type: EnhancedRelationInfo["type"];
    if (expression === "one") {
      type = "one-to-one"; // Could also be many-to-one, we'll refine this
    } else if (expression === "many") {
      type = "one-to-many"; // Could also be many-to-many, we'll refine this
    } else {
      return null;
    }

    const args = callExpression.getArguments();
    if (args.length === 0) {
      return null;
    }

    // First argument should be the related table reference
    const tableArg = args[0];
    if (!tableArg) {
      return null;
    }
    const relatedTable = this.extractTableReference(tableArg);
    if (!relatedTable) {
      return null;
    }

    const relation: EnhancedRelationInfo = {
      name,
      type,
      relatedTable,
      isSelfReferencing: false,
    };

    // Parse optional configuration object
    if (args.length > 1 && Node.isObjectLiteralExpression(args[1])) {
      const config = args[1] as ObjectLiteralExpression;
      const configProps = config.getProperties();

      for (const configProp of configProps) {
        if (Node.isPropertyAssignment(configProp)) {
          const propName = configProp.getName();
          const propValue = configProp.getInitializer();

          switch (propName) {
            case "fields":
              if (Node.isArrayLiteralExpression(propValue)) {
                relation.fields = this.extractArrayValues(propValue);
              }
              break;
            case "references":
              if (Node.isArrayLiteralExpression(propValue)) {
                relation.references = this.extractArrayValues(propValue);
              }
              break;
            case "relationName":
              if (Node.isStringLiteral(propValue)) {
                relation.relationName = propValue.getLiteralValue();
              }
              break;
          }
        }
      }
    }

    // Determine if it's self-referencing
    relation.isSelfReferencing = this.checkIfSelfReferencing(relation);

    // Refine relation type based on context
    relation.type = this.refineRelationType(relation, type);

    return relation;
  }

  private extractTableReference(arg: Node): string | null {
    const text = arg.getText();
    // Handle both direct references (users) and function calls (() => users)
    const match = text.match(/\b(\w+)\s*$/);
    return match?.[1] ?? null;
  }

  private extractArrayValues(arrayLiteral: Node): string[] {
    if (!Node.isArrayLiteralExpression(arrayLiteral)) {
      return [];
    }

    const elements = arrayLiteral.getElements();
    return elements
      .map((element: Node) => {
        const text = element.getText();
        // Handle property access like users.id
        const match = text.match(/\b\w+\.(\w+)\b/);
        return match?.[1] ?? text.replace(/['"]/g, "");
      })
      .filter((value) => value != null && value.length > 0);
  }

  private checkIfSelfReferencing(relation: EnhancedRelationInfo): boolean {
    // This would need to be refined with more context about the current entity
    // For now, we'll mark it as self-referencing if relationName suggests it
    return (
      relation.relationName?.toLowerCase().includes("self") ||
      relation.relationName?.toLowerCase().includes("parent") ||
      relation.relationName?.toLowerCase().includes("child") ||
      false
    );
  }

  private refineRelationType(relation: EnhancedRelationInfo, originalType: string): EnhancedRelationInfo["type"] {
    // Check if it's a junction table relation (many-to-many)
    if (relation.relatedTable.toLowerCase().includes("to") || relation.name.toLowerCase().includes("to")) {
      return "many-to-many";
    }

    // If we have fields/references, it's likely many-to-one when using 'one'
    if (originalType === "one" && relation.fields && relation.references) {
      return "many-to-one";
    }

    // Default mapping
    if (originalType === "one") {
      return "one-to-one";
    } else {
      return "one-to-many";
    }
  }

  private resolveManyToManyRelations(entities: EnhancedEntityInfo[]): void {
    // Create a map of entities by name for quick lookup
    const entitiesMap = new Map(entities.map(e => [e.name, e]));

    // Find junction tables (many-to-many tables)
    const junctionTables = entities.filter(e => e.entityType === 'transactional-many-to-many');

    for (const junctionTable of junctionTables) {
      // Get the foreign keys of the junction table (explicit references)
      const foreignKeys = junctionTable.columns.filter(col => col.references);
      
      // If no explicit foreign keys, infer from ID columns
      let relatedTables: string[] = [];
      if (foreignKeys.length >= 2) {
        relatedTables = foreignKeys.map(fk => fk.references!.table);
      } else {
        // Infer from ID columns (e.g., userId -> users, postId -> posts)
        const idColumns = junctionTable.columns.filter(col => 
          col.name.toLowerCase().endsWith("id") && 
          col.name.toLowerCase() !== "id"
        );
        
        for (const idCol of idColumns) {
          const colName = idCol.name.toLowerCase();
          // Try to match: userId -> users, postId -> posts, categoryId -> categories
          let tableName = colName.replace("id", "");
          
          // Handle plural forms
          if (tableName.endsWith("y")) {
            tableName = tableName.slice(0, -1) + "ies"; // category -> categories
          } else {
            tableName += "s"; // user -> users, post -> posts
          }
          
          // Check if this table exists
          if (entitiesMap.has(tableName)) {
            relatedTables.push(tableName);
          }
        }
      }
      
      // Now update the many-to-many relations
      if (relatedTables.length >= 2) {
        for (let i = 0; i < relatedTables.length; i++) {
          const sourceTableName = relatedTables[i];
          if (!sourceTableName) continue;
          const sourceEntity = entitiesMap.get(sourceTableName);
          
          if (sourceEntity?.relations) {
            // Find the relation that points to this junction table
            const junctionRelation = sourceEntity.relations.find(r => 
              r.relatedTable === junctionTable.name && r.type === 'many-to-many'
            );
            
            if (junctionRelation) {
              // Find the other table as the final target
              const otherTable = relatedTables.find(table => table !== sourceTableName);
              if (otherTable) {
                junctionRelation.finalTarget = otherTable;
                junctionRelation.junctionTable = junctionTable.name;
              }
            }
          }
        }
      }
    }
  }
}
