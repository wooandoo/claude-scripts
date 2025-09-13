#!/usr/bin/env bun

import { Command } from "commander";
import { change } from "./commands/change.js";
import { userStoriesExtract } from "./commands/user-stories-extract.js";
import { entitiesExtract } from "./commands/entities-extract.js";

// --- Commander.js CLI setup ---
const program = new Command();

program.name("claude-scripts").description("Claude scripts useful for commands").version("1.0.0");

// Add commands
program.addCommand(change());
program.addCommand(userStoriesExtract());
program.addCommand(entitiesExtract());

program.parse();
