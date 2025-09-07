#!/usr/bin/env bun

import { Command } from "commander";
import { newSpecification } from "./commands/spec_new.js";

// --- Commander.js CLI setup ---
const program = new Command();

program.name("claude-scripts").description("Claude scripts useful for commands").version("1.0.0");

// Add commands
program.addCommand(newSpecification());

program.parse();
