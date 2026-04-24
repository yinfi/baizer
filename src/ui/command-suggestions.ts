export interface CommandSuggestion {
  label: string;
  desc: string;
}

export interface SkillCommandSuggestionSource {
  command: string;
  description: string;
}

export function buildCommandSuggestions(
  localCommands: CommandSuggestion[],
  skillCommands: SkillCommandSuggestionSource[],
  query: string,
): CommandSuggestion[] {
  const merged = new Map<string, CommandSuggestion>();

  for (const command of localCommands) {
    merged.set(command.label, command);
  }

  for (const skillCommand of skillCommands) {
    merged.set(skillCommand.command, {
      label: skillCommand.command,
      desc: skillCommand.description,
    });
  }

  return Array.from(merged.values())
    .filter(command => command.label.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a.label.localeCompare(b.label));
}
