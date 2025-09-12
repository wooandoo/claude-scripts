#!/usr/bin/env bun

import { Command } from "commander";
import { change } from "./commands/change.js";
import { specExtract } from "./commands/spec-extract.js";

// --- Commander.js CLI setup ---
const program = new Command();

program.name("claude-scripts").description("Claude scripts useful for commands").version("1.0.0");

// Add commands
program.addCommand(change());
program.addCommand(specExtract());

program.parse();
